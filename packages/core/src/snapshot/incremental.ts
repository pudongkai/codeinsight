import { existsSync } from 'node:fs';
import { link, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { isGeneratedPath, isTestPath, type ClassifyOptions } from '../classify/index.js';
import {
  deserializeExtractedFile, extractCacheKey, extractCodeHash, serializeExtractedFile,
} from '../extract/cache.js';
import { extractPythonFile, getPythonParser, resolveCrossFile, sha1, type ExtractedFile, type ExtractResult, type SourceFile } from '../extract/index.js';
import { log } from '../log.js';
import { detectLanguage, supportLevelOf } from '../model/language.js';
import type { FileRow, SnapshotKind, SnapshotRow } from '../model/types.js';
import { snapshotDir, type DataDirLayout } from '../store/data-dir.js';
import type { ExtractCacheEntry } from '../store/extract-cache.js';
import type { Resolver } from '../resolve/types.js';
import type { Store } from '../store/db.js';

/** 建快照被中止时所在的阶段 */
export type BuildStage = 'lock' | 'copy' | 'extract' | 'save' | 'resolve';

export class SnapshotCancelledError extends Error {
  constructor(readonly stage: BuildStage) {
    super(`snapshot build cancelled during ${stage}`);
    this.name = 'SnapshotCancelledError';
  }
}

export function throwIfCancelled(signal: AbortSignal | undefined, stage: BuildStage): void {
  if (signal?.aborted) throw new SnapshotCancelledError(stage);
}

/** 工作区快照除源码外还要放进快照目录的项目配置，scip-python 会读取它们 */
const PROJECT_CONFIG_FILES = new Set(['pyproject.toml', 'setup.cfg', 'pyrightconfig.json']);

/** 需要放进快照目录（交给 scip-python）的文件：支持的语言和项目配置 */
export function isPlaced(rel: string): boolean {
  return supportLevelOf(detectLanguage(rel)) !== 'none' || PROJECT_CONFIG_FILES.has(path.posix.basename(rel));
}

// ---- 上一个快照 ----

export interface PreviousSnapshot {
  snap: SnapshotRow;
  dir: string;
  /** path → files 行 */
  files: Map<string, FileRow>;
}

/** 同类型、提取成功、快照目录还在的最近一个其他快照 */
export function findPreviousSnapshot(store: Store, layout: DataDirLayout, kind: SnapshotKind, excludeId: number): PreviousSnapshot | undefined {
  const snap = store.listSnapshots().find((s) =>
    s.id !== excludeId && s.kind === kind && s.extractStatus === 'ok' && existsSync(snapshotDir(layout, s.contentKey)));
  if (!snap) return undefined;
  return { snap, dir: snapshotDir(layout, snap.contentKey), files: new Map(store.getFiles(snap.id).map((f) => [f.path, f])) };
}

// ---- 读文件、写快照目录 ----

export interface HashedSource extends SourceFile {
  contentHash: string;
}

export interface ReadResult {
  rows: Omit<FileRow, 'snapshotId'>[];
  sources: HashedSource[];
  /** 放进快照目录的符号链接：path → 链接目标 */
  symlinks: Map<string, string>;
  linked: number;
  written: number;
  /** 没能放进快照目录的文件：快照目录里没有它，不能拿来比较或链接 */
  failed: Set<string>;
}

export interface ReadOptions {
  files: string[];
  /** 读取文件的根目录：工作区，或提交快照导出后的目录 */
  srcRoot: string;
  /** 工作区快照的目录；提交快照已由导出写好，不传 */
  destDir?: string;
  prev?: PreviousSnapshot;
  classify: ClassifyOptions;
  signal?: AbortSignal;
}

function fileRow(rel: string, data: Buffer, classify: ClassifyOptions): Omit<FileRow, 'snapshotId'> {
  const language = detectLanguage(rel);
  return {
    path: rel, language, supportLevel: supportLevelOf(language), contentHash: sha1(data),
    isTest: isTestPath(rel, classify), isGenerated: isGeneratedPath(rel, classify),
  };
}

/** 上一个快照里同路径同内容的普通文件硬链接到 dest；条件不满足或链接失败时返回 false */
async function linkFromPrevious(prev: PreviousSnapshot | undefined, rel: string, hash: string, dest: string): Promise<boolean> {
  if (!prev || prev.files.get(rel)?.contentHash !== hash) return false;
  const from = path.join(prev.dir, rel);
  const st = await lstat(from).catch(() => undefined);
  if (!st?.isFile()) return false;
  return link(from, dest).then(() => true, () => false);
}

class SnapshotWriter {
  readonly result: ReadResult = { rows: [], sources: [], symlinks: new Map(), linked: 0, written: 0, failed: new Set() };
  private readonly dirs = new Set<string>();

  constructor(private readonly o: ReadOptions) {}

  private async ensureDir(dest: string): Promise<void> {
    const dir = path.dirname(dest);
    if (this.dirs.has(dir)) return;
    await mkdir(dir, { recursive: true });
    this.dirs.add(dir);
  }

  /** 符号链接按链接本身放进快照目录，不把链接目标（可能在仓库外）的内容复制进来 */
  private async placeSymlink(rel: string, target: string): Promise<void> {
    this.result.symlinks.set(rel, target);
    if (this.o.destDir === undefined) return;
    const dest = path.join(this.o.destDir, rel);
    await this.ensureDir(dest);
    await symlink(target, dest).catch((err: Error) => this.placeFailed(rel, dest, err));
  }

  /** 写入刚读出的内容（不先复制再读），快照目录里的内容和 content_hash 一定一致 */
  private async placeFile(rel: string, data: Buffer, hash: string): Promise<void> {
    const dest = path.join(this.o.destDir!, rel);
    try {
      await this.ensureDir(dest);
      if (await linkFromPrevious(this.o.prev, rel, hash, dest)) {
        this.result.linked++;
        return;
      }
      await writeFile(dest, data);
      this.result.written++;
    } catch (err) {
      await this.placeFailed(rel, dest, err as Error);
    }
  }

  /** 删掉写了一半的文件，之后的构建不会把它当作和 content_hash 一致的内容来链接 */
  private async placeFailed(rel: string, dest: string, err: Error): Promise<void> {
    log.warn('snapshot_copy_failed', { path: rel, error: err.message });
    this.result.failed.add(rel);
    await rm(dest, { force: true }).catch(() => undefined);
  }

  async add(rel: string): Promise<void> {
    const src = path.join(this.o.srcRoot, rel);
    const placed = isPlaced(rel);
    const st = await lstat(src).catch((err: Error) => log.warn('snapshot_read_failed', { path: rel, error: err.message }));
    if (!st) return;
    if (st.isSymbolicLink() && placed) {
      // 符号链接可能在 lstat 之后被删或被替换，读不到目标时跳过这个文件
      const target = await readlink(src).catch((err: Error) => log.warn('snapshot_read_failed', { path: rel, error: err.message }));
      if (target === undefined) return;
      await this.placeSymlink(rel, target);
    }
    const data = await readFile(src).catch((err: Error) => log.warn('snapshot_read_failed', { path: rel, error: err.message }));
    if (!data) return;
    const row = fileRow(rel, data, this.o.classify);
    this.result.rows.push(row);
    if (row.language === 'python') {
      this.result.sources.push({ path: rel, source: data.toString('utf8'), isTest: row.isTest, isGenerated: row.isGenerated, contentHash: row.contentHash });
    }
    if (placed && !st.isSymbolicLink() && this.o.destDir !== undefined) await this.placeFile(rel, data, row.contentHash);
  }
}

/** 读一遍清单里的文件：生成 files 行和提取输入；工作区快照同时写快照目录（没变的文件硬链接到上一个快照） */
export async function readAndPlace(o: ReadOptions): Promise<ReadResult> {
  const writer = new SnapshotWriter(o);
  for (const rel of o.files) {
    throwIfCancelled(o.signal, 'copy');
    await writer.add(rel);
  }
  return writer.result;
}

// ---- 按文件复用提取结果 ----

export interface CachedExtractResult extends ExtractResult {
  cacheHits: number;
  cacheMisses: number;
}

function readCached(data: string | undefined, rel: string): ExtractedFile | undefined {
  if (data === undefined) return undefined;
  try {
    return deserializeExtractedFile(data);
  } catch (err) {
    log.warn('extract_cache_invalid', { path: rel, error: (err as Error).message });
    return undefined;
  }
}

/** 缓存读不出来（写锁等待超时、磁盘满等）时按全部未命中处理，不让整次构建失败 */
function lookupCache(store: Store, keys: readonly string[]): Map<string, string> {
  try {
    return store.extractCache.lookup(keys);
  } catch (err) {
    log.warn('extract_cache_failed', { op: 'lookup', error: (err as Error).message });
    return new Map();
  }
}

/** 缓存只用于加速，写入失败时忽略 */
function putCache(store: Store, entries: readonly ExtractCacheEntry[]): void {
  try {
    store.extractCache.put(entries);
  } catch (err) {
    log.warn('extract_cache_failed', { op: 'put', error: (err as Error).message });
  }
}

/**
 * 提取一批 Python 文件：没变的文件从 extract_cache 取跨文件识别之前的结果，其余重新提取并写入缓存；
 * 然后对全部文件照常做跨文件的入口和模型识别，结果与全量提取相同。单个文件失败时跳过并记日志。
 */
export async function extractWithCache(store: Store, sources: HashedSource[], signal?: AbortSignal): Promise<CachedExtractResult> {
  const parser = await getPythonParser();
  const codeHash = extractCodeHash();
  const keys = sources.map((s) => extractCacheKey(codeHash, s));
  const cached = lookupCache(store, keys);
  const files: ExtractedFile[] = [];
  const fresh: ExtractCacheEntry[] = [];
  let cacheHits = 0;
  for (const [i, s] of sources.entries()) {
    if (signal) await yieldToEventLoop();
    throwIfCancelled(signal, 'extract');
    const hit = readCached(cached.get(keys[i]!), s.path);
    if (hit) {
      cacheHits++;
      files.push(hit);
      continue;
    }
    try {
      const file = extractPythonFile(parser, s.path, s.source, s);
      fresh.push({ key: keys[i]!, path: s.path, data: serializeExtractedFile(file) });
      files.push(file);
    } catch (err) {
      log.warn('extract_file_failed', { path: s.path, error: (err as Error).message });
    }
  }
  putCache(store, fresh);
  return { ...resolveCrossFile(files), cacheHits, cacheMisses: sources.length - cacheHits };
}

// ---- 复用调用边 ----

interface PlacedInfo {
  /** 内容和测试/生成标记 */
  row: string;
  /** 符号链接目标；普通文件为 undefined */
  target: string | undefined;
}

function rowSignature(row: Omit<FileRow, 'snapshotId'> | undefined): string {
  return row ? `${row.contentHash}|${row.isTest ? 1 : 0}|${row.isGenerated ? 1 : 0}` : '-';
}

/** 本次放进快照目录的每个文件 */
function currentPlaced(read: ReadResult): Map<string, PlacedInfo> {
  const out = new Map<string, PlacedInfo>();
  for (const r of read.rows) if (isPlaced(r.path)) out.set(r.path, { row: rowSignature(r), target: undefined });
  for (const [p, target] of read.symlinks) out.set(p, { row: out.get(p)?.row ?? '-', target });
  return out;
}

/**
 * 放进快照目录的全部文件（路径、内容、测试/生成标记、符号链接目标）与上一个快照完全相同时，
 * scip-python 的输入相同，调用边可以直接复用。先只比较 files 行，全部相同时再读上一个快照目录里的符号链接目标。
 */
export async function sameResolverInput(prev: PreviousSnapshot, read: ReadResult): Promise<boolean> {
  if (prev.snap.resolverStatus !== 'ok' || read.failed.size > 0) return false;
  const current = currentPlaced(read);
  const prevPlaced = [...prev.files.values()].filter((f) => isPlaced(f.path));
  if (prevPlaced.length !== current.size) return false;
  if (prevPlaced.some((f) => current.get(f.path)?.row !== rowSignature(f))) return false;
  for (const f of prevPlaced) {
    const file = path.join(prev.dir, f.path);
    const st = await lstat(file).catch(() => undefined);
    if (!st) return false;
    const target = st.isSymbolicLink() ? await readlink(file) : undefined;
    if (current.get(f.path)!.target !== target) return false;
  }
  return true;
}

/** 调用边依赖的代码版本：提取代码指纹（决定符号 id）和解析器的名称、版本 */
export function edgesCodeHash(resolver: Resolver): string {
  return sha1([extractCodeHash(), resolver.name, resolver.version ?? ''].join('\0'));
}

/**
 * 把上一个快照的调用边复制到 snap，返回边数；上一个快照已被清理、解析状态变了，
 * 或它的调用边不是用当前代码版本生成的时返回 undefined
 */
export function reuseEdges(store: Store, prev: SnapshotRow, snap: SnapshotRow, codeHash: string): number | undefined {
  return store.transaction(() => {
    const p = store.getSnapshot(prev.id);
    if (p?.resolverStatus !== 'ok' || store.getEdgesCodeHash(p.id) !== codeHash) return undefined;
    store.clearSnapshotData(snap.id, 'edges');
    const edges = store.copyEdges(p.id, snap.id);
    store.setSnapshotStatus(snap.id, { resolverStatus: 'ok', resolverError: p.resolverError });
    store.setEdgesCodeHash(snap.id, codeHash);
    return edges;
  });
}
