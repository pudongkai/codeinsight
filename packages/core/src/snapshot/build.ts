import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { dataDirInRepo, type CodeInsightConfig } from '../config/index.js';
import { getPythonParser, restoreExtractedFile, type ExtractedFile, type ExtractResult } from '../extract/index.js';
import { exportArchive, listCommitFiles, listWorkingFiles, repoRoot, resolveRef, workingContentKey } from '../git/index.js';
import { log } from '../log.js';
import type { SnapshotKind, SnapshotRow, SymbolRow } from '../model/types.js';
import { ScipPythonResolver } from '../resolve/scip-python.js';
import type { Resolver } from '../resolve/types.js';
import { acquireSnapshotLock, cleanupSnapshots, snapshotDir, type DataDirLayout, type LockHandle } from '../store/data-dir.js';
import type { Store } from '../store/db.js';
import {
  edgesCodeHash, extractWithCache, findPreviousSnapshot, readAndPlace, reuseEdges, sameResolverInput, SnapshotCancelledError, throwIfCancelled,
  type PreviousSnapshot, type ReadResult,
} from './incremental.js';

export { SnapshotCancelledError, type BuildStage } from './incremental.js';

export interface BuildSnapshotOptions {
  repo: string;
  store: Store;
  layout: DataDirLayout;
  config: CodeInsightConfig;
  /** 提交 ref；不传时索引工作区 */
  ref?: string;
  /** 默认 ScipPythonResolver */
  resolver?: Resolver;
  /** 中止后在下一个检查点以 SnapshotCancelledError 结束，正在运行的 scip-python 会被结束 */
  signal?: AbortSignal;
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

/**
 * 准备快照目录并读一遍文件。提交快照从 git 对象导出；工作区快照只放清单里支持语言的文件和项目配置
 * （清单外的目录如 venv 不会被 scip-python 扫描），没变的文件硬链接到上一个快照目录。
 */
async function prepareFiles(opts: BuildSnapshotOptions, t: Target, prev: PreviousSnapshot | undefined): Promise<{ dir: string; read: ReadResult }> {
  const { config, layout, signal } = opts;
  const started = Date.now();
  const dir = snapshotDir(layout, t.contentKey);
  const classify = { testGlobs: config.testGlobs, generatedGlobs: config.generatedGlobs };
  let read: ReadResult;
  if (t.kind === 'commit') {
    await exportArchive(t.root, t.commitSha, dir);
    read = await readAndPlace({ files: await listCommitFiles(t.root, t.commitSha), srcRoot: dir, classify, signal });
  } else {
    const files = await listWorkingFiles(t.root, excludeDirs(config, t.root));
    await rm(dir, { recursive: true, force: true });
    read = await readAndPlace({ files, srcRoot: t.root, destDir: dir, prev, classify, signal });
  }
  log.info('snapshot_copied', {
    contentKey: t.contentKey, files: read.rows.length, linked: read.linked, written: read.written,
    fromSnapshot: prev?.snap.contentKey, ms: Date.now() - started,
  });
  return { dir, read };
}

function saveExtraction(store: Store, snapshotId: number, read: ReadResult, extracted: ExtractResult): void {
  store.transaction(() => {
    store.insertFiles(read.rows.map((r) => ({ ...r, snapshotId })));
    store.insertSymbols(extracted.files.flatMap((f) => f.symbols.map(({ nameLine: _l, nameCol: _c, ...s }) => ({ ...s, snapshotId }))));
    store.insertEntries(extracted.entries.map((e) => ({ ...e, snapshotId })));
    store.setSnapshotStatus(snapshotId, { extractStatus: 'ok' });
  });
}

/** 中止时写进 resolver_error 的值 */
const CANCELLED = 'cancelled';

/** 提取已入库、解析前或解析中被中止：标记 resolver_status=failed（下次只重跑解析）后抛出 */
function cancelResolve(store: Store, snap: SnapshotRow, stage: 'save' | 'resolve'): never {
  store.setSnapshotStatus(snap.id, { resolverStatus: 'failed', resolverError: CANCELLED });
  throw new SnapshotCancelledError(stage);
}

function resolverOf(opts: BuildSnapshotOptions): Resolver {
  return opts.resolver ?? new ScipPythonResolver();
}

/** 解析失败只标记 resolver_status=failed，提取结果保留 */
async function runResolver(
  opts: BuildSnapshotOptions, snap: SnapshotRow, dir: string, files: ExtractedFile[],
): Promise<void> {
  const { store, layout, config, signal } = opts;
  if (signal?.aborted) cancelResolve(store, snap, 'resolve');
  if (files.length === 0) {
    store.setSnapshotStatus(snap.id, { resolverStatus: 'skipped', resolverError: 'no supported source files' });
    return;
  }
  const resolver = resolverOf(opts);
  const started = Date.now();
  try {
    const result = await resolver.resolve({
      snapshotId: snap.id, contentKey: snap.contentKey, root: dir, layout, files, timeoutMs: config.scipTimeoutMs, signal,
    });
    store.transaction(() => {
      store.clearSnapshotData(snap.id, 'edges');
      store.insertEdges(result.edges);
      store.setSnapshotStatus(snap.id, { resolverStatus: 'ok', resolverError: result.note ?? null });
      store.setEdgesCodeHash(snap.id, edgesCodeHash(resolver));
    });
    log.info('resolve_done', { resolver: resolver.name, edges: result.edges.length, ms: Date.now() - started });
    if (result.note) log.warn('resolve_note', { contentKey: snap.contentKey, note: result.note });
  } catch (err) {
    if (signal?.aborted) cancelResolve(store, snap, 'resolve');
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

/** 放进快照目录的文件和上一个快照完全相同时复用它的调用边，不跑 scip-python */
async function tryReuseEdges(opts: BuildSnapshotOptions, prev: PreviousSnapshot | undefined, snap: SnapshotRow, read: ReadResult): Promise<boolean> {
  const { store } = opts;
  const codeHash = edgesCodeHash(resolverOf(opts));
  if (!prev || store.getEdgesCodeHash(prev.snap.id) !== codeHash || !(await sameResolverInput(prev, read))) return false;
  const edges = reuseEdges(store, prev.snap, snap, codeHash);
  if (edges === undefined) return false;
  log.info('resolve_reused', { contentKey: snap.contentKey, fromSnapshot: prev.snap.contentKey, edges });
  return true;
}

async function buildLocked(opts: BuildSnapshotOptions, t: Target): Promise<BuildSnapshotResult> {
  const { store, layout, signal } = opts;
  const started = Date.now();
  log.info('snapshot_build_start', { kind: t.kind, contentKey: t.contentKey });
  const snap = startSnapshot(store, t);
  const prev = findPreviousSnapshot(store, layout, t.kind, snap.id);
  const { dir, read } = await prepareFiles(opts, t, prev);
  const parseStarted = Date.now();
  const extracted = await extractWithCache(store, read.sources, signal);
  saveExtraction(store, snap.id, read, extracted);
  const extractMs = Date.now() - started;
  const symbols = extracted.files.reduce((n, f) => n + f.symbols.length, 0);
  log.info('extract_done', {
    files: read.rows.length, python: extracted.files.length, symbols, entries: extracted.entries.length, models: extracted.models,
    cacheHits: extracted.cacheHits, cacheMisses: extracted.cacheMisses, parseMs: Date.now() - parseStarted, ms: extractMs,
  });
  if (signal?.aborted) cancelResolve(store, snap, 'save');
  if (!(await tryReuseEdges(opts, prev, snap, read))) await runResolver(opts, snap, dir, extracted.files);
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

/** 解析真正失败过（不是被中止）的快照：等锁后直接复用，不立刻重试 */
function resolveFailedNotCancelled(snap: SnapshotRow | undefined): boolean {
  return snap?.extractStatus === 'ok' && snap.resolverStatus === 'failed' && snap.resolverError !== CANCELLED;
}

/**
 * 持锁后重新检查（其他进程可能刚构建完并释放锁）：整体复用、只重试解析，或完整构建。
 * 等待过其他进程时，它的结果即使是解析失败也直接复用，重试留给之后独立的一次构建；它被中止留下的快照照常重试解析。
 */
async function buildOrReuse(opts: BuildSnapshotOptions, t: Target, waited: boolean): Promise<BuildSnapshotResult> {
  const snap = opts.store.getSnapshotByKey(t.contentKey);
  const after = reusable(opts.store, t.contentKey) ?? (waited && resolveFailedNotCancelled(snap) ? snap : undefined);
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

/** 获取快照锁；等锁期间被中止时以 SnapshotCancelledError 结束 */
async function lockSnapshot(opts: BuildSnapshotOptions, contentKey: string): Promise<LockHandle> {
  try {
    return await acquireSnapshotLock(opts.layout, contentKey, { signal: opts.signal });
  } catch (err) {
    throwIfCancelled(opts.signal, 'lock');
    throw err;
  }
}

/**
 * 快照构建流水线：准备源码 → 提取 → scip-python → 转换入库。按 content_key 复用已有结果，
 * 上次解析失败的快照只重跑解析；内容键变了时按文件复用上一个快照的文件和提取结果，
 * 放进快照目录的文件都没变时复用调用边。
 * 构建前获取快照锁，其他进程正在构建同一个快照时等它完成后直接复用。
 */
export async function buildSnapshot(opts: BuildSnapshotOptions): Promise<BuildSnapshotResult> {
  const t = await resolveTarget(opts);
  const hit = reusable(opts.store, t.contentKey);
  if (hit) {
    log.info('snapshot_cache_hit', { kind: t.kind, contentKey: t.contentKey, snapshotId: hit.id });
    return { snapshot: hit, cached: true, resolveRetried: false };
  }
  let result: BuildSnapshotResult;
  try {
    const lock = await lockSnapshot(opts, t.contentKey);
    try {
      result = await buildOrReuse(opts, t, lock.waited);
    } finally {
      await lock.release();
    }
  } catch (err) {
    if (err instanceof SnapshotCancelledError) log.info('snapshot_build_cancelled', { contentKey: t.contentKey, stage: err.stage });
    throw err;
  }
  await cleanupSnapshots(opts.store, opts.layout).catch((err: Error) => log.warn('snapshot_cleanup_failed', { error: err.message }));
  return result;
}
