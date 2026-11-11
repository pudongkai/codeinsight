import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { isGeneratedPath, isTestPath, type ClassifyOptions } from '../classify/index.js';
import { dataDirInRepo, type CodeInsightConfig } from '../config/index.js';
import { extractPythonFiles, getPythonParser, restoreExtractedFile, sha1, type ExtractedFile, type ExtractResult, type SourceFile } from '../extract/index.js';
import { exportArchive, listCommitFiles, listWorkingFiles, repoRoot, resolveRef, workingContentKey } from '../git/index.js';
import { log } from '../log.js';
import { detectLanguage, supportLevelOf } from '../model/language.js';
import type { FileRow, SnapshotKind, SnapshotRow, SymbolRow } from '../model/types.js';
import { ScipPythonResolver } from '../resolve/scip-python.js';
import type { Resolver } from '../resolve/types.js';
import { acquireSnapshotLock, cleanupSnapshots, snapshotDir, type DataDirLayout } from '../store/data-dir.js';
import type { Store } from '../store/db.js';

/** 工作区快照除源码外还要复制的项目配置，scip-python 会读取它们 */
const PROJECT_CONFIG_FILES = new Set(['pyproject.toml', 'setup.cfg', 'pyrightconfig.json']);

export interface BuildSnapshotOptions {
  repo: string;
  store: Store;
  layout: DataDirLayout;
  config: CodeInsightConfig;
  /** 提交 ref；不传时索引工作区 */
  ref?: string;
  /** 默认 ScipPythonResolver */
  resolver?: Resolver;
}

export interface BuildSnapshotResult {
  snapshot: SnapshotRow;
  /** 整体复用了已有快照 */
  cached: boolean;
  /** 复用了已入库的提取结果，只重跑了解析（上次解析失败时） */
  resolveRetried: boolean;
}

interface Target {
  root: string;
  kind: SnapshotKind;
  commitSha: string;
  contentKey: string;
}

interface Prepared {
  /** 文件清单 */
  files: string[];
  /** 快照源码目录，scip-python 在这里运行 */
  dir: string;
  read(rel: string): Promise<Buffer>;
}

async function resolveTarget(opts: BuildSnapshotOptions): Promise<Target> {
  const root = await repoRoot(opts.repo);
  if (opts.ref !== undefined) {
    const sha = await resolveRef(root, opts.ref);
    return { root, kind: 'commit', commitSha: sha, contentKey: sha };
  }
  const head = await resolveRef(root, 'HEAD');
  const contentKey = await workingContentKey(root, head, excludeDirs(opts.config, root));
  return { root, kind: 'working', commitSha: head, contentKey };
}

/** 文件清单要排除的仓库内数据目录 */
export function excludeDirs(config: CodeInsightConfig, root: string): string[] {
  const rel = dataDirInRepo({ repo: root, dataDir: config.dataDir });
  return rel ? [rel] : [];
}

/** 提取完成且解析成功（或无需解析）的快照整体复用；解析失败的要重试解析 */
function reusable(store: Store, contentKey: string): SnapshotRow | undefined {
  const snap = store.getSnapshotByKey(contentKey);
  if (!snap || snap.extractStatus !== 'ok' || (snap.resolverStatus !== 'ok' && snap.resolverStatus !== 'skipped')) return undefined;
  store.touchSnapshot(snap.id);
  return store.getSnapshot(snap.id);
}

async function prepareCommit(t: Target, layout: DataDirLayout): Promise<Prepared> {
  const dir = snapshotDir(layout, t.contentKey);
  await exportArchive(t.root, t.commitSha, dir);
  return { files: await listCommitFiles(t.root, t.commitSha), dir, read: (rel) => readFile(path.join(dir, rel)) };
}

/** 工作区：只把清单里支持语言的文件和项目配置复制到快照目录，清单外的目录（如 venv）不会被 scip-python 扫描 */
async function prepareWorking(t: Target, layout: DataDirLayout, config: CodeInsightConfig): Promise<Prepared> {
  const dir = snapshotDir(layout, t.contentKey);
  const files = await listWorkingFiles(t.root, excludeDirs(config, t.root));
  await rm(dir, { recursive: true, force: true });
  for (const rel of files) {
    if (supportLevelOf(detectLanguage(rel)) === 'none' && !PROJECT_CONFIG_FILES.has(path.posix.basename(rel))) continue;
    const dest = path.join(dir, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(path.join(t.root, rel), dest).catch((err: Error) => log.warn('snapshot_copy_failed', { path: rel, error: err.message }));
  }
  log.info('snapshot_copied', { contentKey: t.contentKey, files: files.length });
  return { files, dir, read: (rel) => readFile(path.join(t.root, rel)) };
}

interface ReadFiles {
  rows: Omit<FileRow, 'snapshotId'>[];
  sources: SourceFile[];
}

/** 读取清单里的文件：每个文件生成 files 行，支持的语言再交给提取层 */
async function readFiles(prepared: Prepared, classify: ClassifyOptions): Promise<ReadFiles> {
  const out: ReadFiles = { rows: [], sources: [] };
  for (const rel of prepared.files) {
    const data = await prepared.read(rel).catch((err: Error) => {
      log.warn('snapshot_read_failed', { path: rel, error: err.message });
      return undefined;
    });
    if (!data) continue;
    const language = detectLanguage(rel);
    const supportLevel = supportLevelOf(language);
    const isTest = isTestPath(rel, classify);
    const isGenerated = isGeneratedPath(rel, classify);
    out.rows.push({ path: rel, language, supportLevel, contentHash: sha1(data), isTest, isGenerated });
    if (language === 'python') out.sources.push({ path: rel, source: data.toString('utf8'), isTest, isGenerated });
  }
  return out;
}

function saveExtraction(store: Store, snapshotId: number, read: ReadFiles, extracted: ExtractResult): void {
  store.transaction(() => {
    store.insertFiles(read.rows.map((r) => ({ ...r, snapshotId })));
    store.insertSymbols(extracted.files.flatMap((f) => f.symbols.map(({ nameLine: _l, nameCol: _c, ...s }) => ({ ...s, snapshotId }))));
    store.insertEntries(extracted.entries.map((e) => ({ ...e, snapshotId })));
    store.setSnapshotStatus(snapshotId, { extractStatus: 'ok' });
  });
}

/** 解析失败只标记 resolver_status=failed，提取结果保留 */
async function runResolver(
  opts: BuildSnapshotOptions, snap: SnapshotRow, dir: string, files: ExtractedFile[],
): Promise<void> {
  const { store, layout, config } = opts;
  if (files.length === 0) {
    store.setSnapshotStatus(snap.id, { resolverStatus: 'skipped', resolverError: 'no supported source files' });
    return;
  }
  const resolver = opts.resolver ?? new ScipPythonResolver();
  const started = Date.now();
  try {
    const result = await resolver.resolve({
      snapshotId: snap.id, contentKey: snap.contentKey, root: dir, layout, files, timeoutMs: config.scipTimeoutMs,
    });
    store.transaction(() => {
      store.clearSnapshotData(snap.id, 'edges');
      store.insertEdges(result.edges);
      store.setSnapshotStatus(snap.id, { resolverStatus: 'ok', resolverError: result.note ?? null });
    });
    log.info('resolve_done', { resolver: resolver.name, edges: result.edges.length, ms: Date.now() - started });
    if (result.note) log.warn('resolve_note', { contentKey: snap.contentKey, note: result.note });
  } catch (err) {
    const reason = (err as Error).message;
    store.setSnapshotStatus(snap.id, { resolverStatus: 'failed', resolverError: reason });
    log.warn('resolve_failed', { resolver: resolver.name, contentKey: snap.contentKey, error: reason });
  }
}

/** 建或重置快照行：上次构建中断留下的半成品先清空 */
function startSnapshot(store: Store, t: Target): SnapshotRow {
  const existing = store.getSnapshotByKey(t.contentKey);
  if (!existing) return store.createSnapshot(t.kind, t.commitSha, t.contentKey);
  store.transaction(() => {
    store.clearSnapshotData(existing.id, 'extract');
    store.setSnapshotStatus(existing.id, { extractStatus: 'pending', resolverStatus: 'pending', resolverError: null });
  });
  store.touchSnapshot(existing.id);
  return store.getSnapshot(existing.id)!;
}

async function buildLocked(opts: BuildSnapshotOptions, t: Target): Promise<BuildSnapshotResult> {
  const { store, layout, config } = opts;
  const started = Date.now();
  log.info('snapshot_build_start', { kind: t.kind, contentKey: t.contentKey });
  const snap = startSnapshot(store, t);
  const prepared = t.kind === 'commit' ? await prepareCommit(t, layout) : await prepareWorking(t, layout, config);
  const read = await readFiles(prepared, { testGlobs: config.testGlobs, generatedGlobs: config.generatedGlobs });
  const extracted = await extractPythonFiles(read.sources);
  saveExtraction(store, snap.id, read, extracted);
  const extractMs = Date.now() - started;
  const symbols = extracted.files.reduce((n, f) => n + f.symbols.length, 0);
  log.info('extract_done', { files: read.rows.length, python: extracted.files.length, symbols, entries: extracted.entries.length, ms: extractMs });
  await runResolver(opts, snap, prepared.dir, extracted.files);
  log.info('snapshot_build_done', { contentKey: t.contentKey, extractMs, totalMs: Date.now() - started });
  return { snapshot: store.getSnapshot(snap.id)!, cached: false, resolveRetried: false };
}

/** 从库里的符号还原解析层输入；源码从快照目录读 */
async function restoreExtracted(store: Store, snap: SnapshotRow, dir: string): Promise<ExtractedFile[]> {
  const parser = await getPythonParser();
  const byPath = new Map<string, Omit<SymbolRow, 'snapshotId'>[]>();
  for (const s of store.getSymbols(snap.id)) byPath.set(s.path, [...(byPath.get(s.path) ?? []), s]);
  const files: ExtractedFile[] = [];
  for (const f of store.getFiles(snap.id)) {
    const rows = byPath.get(f.path);
    if (f.supportLevel !== 'full' || !rows) continue;
    files.push(restoreExtractedFile(parser, f.path, await readFile(path.join(dir, f.path), 'utf8'), rows));
  }
  return files;
}

/** 上次解析失败的快照：复用已入库的提取结果和快照目录，只重跑解析 */
async function retryResolve(opts: BuildSnapshotOptions, snap: SnapshotRow, dir: string): Promise<BuildSnapshotResult> {
  const started = Date.now();
  log.info('resolve_retry_start', { contentKey: snap.contentKey, previousError: snap.resolverError?.split('\n')[0] });
  opts.store.touchSnapshot(snap.id);
  await runResolver(opts, snap, dir, await restoreExtracted(opts.store, snap, dir));
  log.info('resolve_retry_done', { contentKey: snap.contentKey, totalMs: Date.now() - started });
  return { snapshot: opts.store.getSnapshot(snap.id)!, cached: false, resolveRetried: true };
}

/**
 * 持锁后重新检查（其他进程可能刚构建完并释放锁）：整体复用、只重试解析，或完整构建。
 * 等待过其他进程时，它的结果即使是解析失败也直接复用，重试留给之后独立的一次构建。
 */
async function buildOrReuse(opts: BuildSnapshotOptions, t: Target, waited: boolean): Promise<BuildSnapshotResult> {
  const snap = opts.store.getSnapshotByKey(t.contentKey);
  const after = reusable(opts.store, t.contentKey) ?? (waited && snap?.extractStatus === 'ok' && snap.resolverStatus === 'failed' ? snap : undefined);
  if (after) {
    opts.store.touchSnapshot(after.id);
    log.info('snapshot_cache_hit', { kind: t.kind, contentKey: t.contentKey, snapshotId: after.id, waited, resolverStatus: after.resolverStatus });
    return { snapshot: opts.store.getSnapshot(after.id)!, cached: true, resolveRetried: false };
  }
  const dir = snapshotDir(opts.layout, t.contentKey);
  if (snap?.extractStatus === 'ok' && snap.resolverStatus === 'failed' && existsSync(dir)) {
    return retryResolve(opts, snap, dir);
  }
  return buildLocked(opts, t);
}

/**
 * 快照构建流水线：准备源码 → 提取 → scip-python → 转换入库。按 content_key 复用已有结果，
 * 上次解析失败的快照只重跑解析；
 * 构建前获取快照锁，其他进程正在构建同一个快照时等它完成后直接复用。
 */
export async function buildSnapshot(opts: BuildSnapshotOptions): Promise<BuildSnapshotResult> {
  const t = await resolveTarget(opts);
  const hit = reusable(opts.store, t.contentKey);
  if (hit) {
    log.info('snapshot_cache_hit', { kind: t.kind, contentKey: t.contentKey, snapshotId: hit.id });
    return { snapshot: hit, cached: true, resolveRetried: false };
  }
  const lock = await acquireSnapshotLock(opts.layout, t.contentKey);
  let result: BuildSnapshotResult;
  try {
    result = await buildOrReuse(opts, t, lock.waited);
  } finally {
    await lock.release();
  }
  await cleanupSnapshots(opts.store, opts.layout).catch((err: Error) => log.warn('snapshot_cleanup_failed', { error: err.message }));
  return result;
}
