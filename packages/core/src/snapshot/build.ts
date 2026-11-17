import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { dataDirInRepo, type CodeInsightConfig } from '../config/index.js';
import { completeForResolve, goModuleEntry, loadParsers, type ExtractContext, type ExtractedFile, type ExtractResult } from '../extract/index.js';
import { exportArchive, listCommitFiles, listWorkingFiles, repoRoot, resolveRef, workingContentKey } from '../git/index.js';
import { log } from '../log.js';
import type { Language } from '../model/language.js';
import type { FileRow, SnapshotKind, SnapshotRow, SymbolRow } from '../model/types.js';
import { hasFailedFallback, mayNeedReresolve, sourcesText } from '../resolve/edge-sources.js';
import { defaultResolver } from '../resolve/language-resolver.js';
import type { FailedLanguage, Resolver, ResolveResult } from '../resolve/types.js';
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
  /** 默认 defaultResolver()（按语言组合）；传入的实例会被 prepare，一个实例只用于一次构建 */
  resolver?: Resolver;
  /** 中止后在下一个检查点以 SnapshotCancelledError 结束，正在运行的 scip-python 会被结束 */
  signal?: AbortSignal;
}

export interface BuildSnapshotResult {
  snapshot: SnapshotRow;
  /** 整体复用了已有快照 */
  cached: boolean;
  /** 复用了已入库的提取结果，只重跑了解析（上次解析失败，或名称匹配得到的边需要重新解析时） */
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
  return opts.resolver ?? defaultResolver();
}

/**
 * 解析失败（整体失败、prepare 失败或被中止）：标记 resolver_status=failed，提取结果保留；
 * 清掉各语言边来源和边的复用指纹，免得界面上还显示上一次解析的来源说明
 */
function markResolveFailed(opts: BuildSnapshotOptions, snap: SnapshotRow, resolver: Resolver, err: unknown): void {
  const { store } = opts;
  store.transaction(() => {
    store.setEdgeSources(snap.id, null);
    store.clearEdgesCodeHash(snap.id);
  });
  if (opts.signal?.aborted) cancelResolve(store, snap, 'resolve');
  const reason = (err as Error).message;
  store.setSnapshotStatus(snap.id, { resolverStatus: 'failed', resolverError: reason });
  log.warn('resolve_failed', { resolver: resolver.name, contentKey: snap.contentKey, error: reason });
}

/** 用本快照出现的语言 prepare 解析器；失败时按解析失败处理并返回 false */
async function prepareResolver(opts: BuildSnapshotOptions, snap: SnapshotRow, resolver: Resolver, languages: Language[]): Promise<boolean> {
  try {
    await resolver.prepare?.([...new Set(languages)]);
    return true;
  } catch (err) {
    markResolveFailed(opts, snap, resolver, err);
    return false;
  }
}

function failedText(failed: FailedLanguage[], note: string | undefined): string {
  return [...failed.map((f) => `${f.language}: ${f.reason}`), ...(note ? [note] : [])].join('\n');
}

/**
 * 解析结果入库。有语言失败时边照常入库、resolver_status=failed，不写 edges_code_hash（下次所有语言重跑）；
 * 全部成功时按实际生效的版本写 edges_code_hash，因为外部工具运行失败而回退到名称匹配的不写（不复用）
 */
function saveResolveResult(store: Store, snap: SnapshotRow, resolver: Resolver, result: ResolveResult): void {
  const failed = result.failed ?? [];
  store.transaction(() => {
    store.clearSnapshotData(snap.id, 'edges');
    store.insertEdges(result.edges);
    store.setSnapshotStatus(snap.id, failed.length > 0
      ? { resolverStatus: 'failed', resolverError: failedText(failed, result.note) }
      : { resolverStatus: 'ok', resolverError: result.note ?? null });
    store.setEdgeSources(snap.id, result.sources ?? null);
    if (failed.length === 0 && !hasFailedFallback(result.sources)) {
      store.setEdgesCodeHash(snap.id, edgesCodeHash(resolver, result.effectiveVersion ?? resolver.version));
    } else {
      store.clearEdgesCodeHash(snap.id);
    }
  });
}

/** 解析失败只标记 resolver_status=failed，提取结果保留；部分语言失败时其他语言的边照常入库 */
async function runResolver(
  opts: BuildSnapshotOptions, resolver: Resolver, snap: SnapshotRow, dir: string, files: ExtractedFile[],
): Promise<void> {
  const { store, layout, config, signal } = opts;
  if (signal?.aborted) cancelResolve(store, snap, 'resolve');
  if (files.length === 0) {
    store.setSnapshotStatus(snap.id, { resolverStatus: 'skipped', resolverError: 'no supported source files' });
    return;
  }
  const started = Date.now();
  try {
    const result = await resolver.resolve({
      snapshotId: snap.id, contentKey: snap.contentKey, root: dir, layout, files, timeoutMs: config.scipTimeoutMs, signal,
    });
    saveResolveResult(store, snap, resolver, result);
    const failed = result.failed?.map((f) => f.language).join(',');
    log.info('resolve_done', { resolver: resolver.name, edges: result.edges.length, sources: sourcesText(result.sources), failed, ms: Date.now() - started });
    if (failed) log.warn('resolve_partial_failed', { contentKey: snap.contentKey, languages: failed });
    if (result.note) log.warn('resolve_note', { contentKey: snap.contentKey, note: result.note });
  } catch (err) {
    markResolveFailed(opts, snap, resolver, err);
  }
}

/** 建或重置快照行：上次构建中断留下的半成品先清空 */
function startSnapshot(store: Store, t: Target): SnapshotRow {
  const existing = store.getSnapshotByKey(t.contentKey);
  if (!existing) return store.createSnapshot(t.kind, t.commitSha, t.contentKey);
  store.transaction(() => {
    store.clearSnapshotData(existing.id, 'extract');
    store.setSnapshotStatus(existing.id, { extractStatus: 'pending', resolverStatus: 'pending', resolverError: null });
    store.setEdgeSources(existing.id, null);
  });
  store.touchSnapshot(existing.id);
  return store.getSnapshot(existing.id)!;
}

/** 放进快照目录的文件和上一个快照完全相同时复用它的调用边，不跑解析；resolver 已经 prepare 过 */
async function tryReuseEdges(
  opts: BuildSnapshotOptions, resolver: Resolver, prev: PreviousSnapshot | undefined, snap: SnapshotRow, read: ReadResult,
): Promise<boolean> {
  const { store } = opts;
  const codeHash = edgesCodeHash(resolver);
  if (!prev || store.getEdgesCodeHash(prev.snap.id) !== codeHash || !(await sameResolverInput(prev, read))) return false;
  const edges = reuseEdges(store, prev.snap, snap, codeHash);
  if (edges === undefined) return false;
  log.info('resolve_reused', { contentKey: snap.contentKey, fromSnapshot: prev.snap.contentKey, edges });
  return true;
}

async function buildLocked(opts: BuildSnapshotOptions, t: Target, resolver: Resolver): Promise<BuildSnapshotResult> {
  const { store, layout, signal } = opts;
  const started = Date.now();
  log.info('snapshot_build_start', { kind: t.kind, contentKey: t.contentKey });
  const snap = startSnapshot(store, t);
  const prev = findPreviousSnapshot(store, layout, t.kind, snap.id);
  const { dir, read } = await prepareFiles(opts, t, prev);
  const parseStarted = Date.now();
  const extracted = await extractWithCache(store, read.sources, signal, { goModules: read.goModules });
  saveExtraction(store, snap.id, read, extracted);
  const extractMs = Date.now() - started;
  const symbols = extracted.files.reduce((n, f) => n + f.symbols.length, 0);
  log.info('extract_done', {
    files: read.rows.length, extracted: extracted.files.length, languages: countByLanguage(extracted.files), symbols, entries: extracted.entries.length, models: extracted.models,
    cacheHits: extracted.cacheHits, cacheMisses: extracted.cacheMisses, parseMs: Date.now() - parseStarted, ms: extractMs,
  });
  if (signal?.aborted) cancelResolve(store, snap, 'save');
  if (await prepareResolver(opts, snap, resolver, extracted.files.map((f) => f.language))) {
    if (!(await tryReuseEdges(opts, resolver, prev, snap, read))) await runResolver(opts, resolver, snap, dir, extracted.files);
  }
  log.info('snapshot_build_done', { contentKey: t.contentKey, extractMs, totalMs: Date.now() - started });
  return { snapshot: store.getSnapshot(snap.id)!, cached: false, resolveRetried: false };
}

/** 各语言提取出的文件数 */
function countByLanguage(files: ExtractedFile[]): Partial<Record<Language, number>> {
  const out: Partial<Record<Language, number>> = {};
  for (const f of files) out[f.language] = (out[f.language] ?? 0) + 1;
  return out;
}

/** 从快照目录里的 go.mod 重新得到提取上下文，和提取时一致；读不到的 go.mod 跳过 */
async function snapshotExtractContext(files: FileRow[], dir: string): Promise<ExtractContext> {
  const goModules = new Map<string, string>();
  for (const f of files) {
    if (path.posix.basename(f.path) !== 'go.mod') continue;
    const text = await readFile(path.join(dir, f.path), 'utf8').catch(() => undefined);
    const entry = text === undefined ? undefined : goModuleEntry(f.path, text);
    if (entry) goModules.set(...entry);
  }
  return { goModules };
}

/** 从库里的符号按语言还原解析层输入，再补齐跨文件信息；源码从快照目录读 */
async function restoreExtracted(store: Store, snap: SnapshotRow, dir: string): Promise<ExtractedFile[]> {
  const byPath = new Map<string, Omit<SymbolRow, 'snapshotId'>[]>();
  for (const s of store.getSymbols(snap.id)) byPath.set(s.path, [...(byPath.get(s.path) ?? []), s]);
  const rows = store.getFiles(snap.id);
  const full = rows.filter((f) => f.supportLevel === 'full' && byPath.has(f.path));
  const parsers = await loadParsers(full.map((f) => f.language));
  const ctx = await snapshotExtractContext(rows, dir);
  const files: ExtractedFile[] = [];
  for (const f of full) {
    const p = parsers.get(f.language);
    if (!p) continue;
    const source = await readFile(path.join(dir, f.path), 'utf8');
    files.push(p.support.restoreFile(p.parser, f.path, source, byPath.get(f.path)!, ctx));
  }
  completeForResolve(files);
  return files;
}

/** 上次解析失败或需要重新解析的快照：复用已入库的提取结果和快照目录，只重跑解析 */
async function retryResolve(opts: BuildSnapshotOptions, resolver: Resolver, snap: SnapshotRow, dir: string): Promise<BuildSnapshotResult> {
  const started = Date.now();
  log.info('resolve_retry_start', { contentKey: snap.contentKey, previousError: snap.resolverError?.split('\n')[0], sources: sourcesText(snap.edgeSources) });
  opts.store.touchSnapshot(snap.id);
  const files = await restoreExtracted(opts.store, snap, dir);
  if (await prepareResolver(opts, snap, resolver, files.map((f) => f.language))) await runResolver(opts, resolver, snap, dir, files);
  log.info('resolve_retry_done', { contentKey: snap.contentKey, totalMs: Date.now() - started });
  return { snapshot: opts.store.getSnapshot(snap.id)!, cached: false, resolveRetried: true };
}

/** 解析真正失败过（不是被中止）的快照：等锁后直接复用，不立刻重试 */
function resolveFailedNotCancelled(snap: SnapshotRow | undefined): boolean {
  return snap?.extractStatus === 'ok' && snap.resolverStatus === 'failed' && snap.resolverError !== CANCELLED;
}

/**
 * 名称匹配得到的边现在是否应该重新解析（如之前找不到的 scip 工具现在找到了）：先按记录粗筛（mayNeedReresolve），
 * 再 prepare 解析器后问它；判断出错时按不需要处理
 */
async function needsReresolve(snap: SnapshotRow, resolver: Resolver): Promise<boolean> {
  const sources = snap.edgeSources;
  if (snap.resolverStatus !== 'ok' || !sources || !mayNeedReresolve(sources) || !resolver.needsReresolve) return false;
  try {
    await resolver.prepare?.(Object.keys(sources) as Language[]);
    const needed = await resolver.needsReresolve(sources);
    log.info('reresolve_check', { contentKey: snap.contentKey, needed, sources: sourcesText(sources) });
    return needed;
  } catch (err) {
    log.warn('reresolve_check_failed', { contentKey: snap.contentKey, error: (err as Error).message });
    return false;
  }
}

/**
 * 持锁后重新检查（其他进程可能刚构建完并释放锁）：整体复用、只重跑解析，或完整构建。
 * 等待过其他进程时，它的结果即使是解析失败也直接复用，重试留给之后独立的一次构建；它被中止留下的快照照常重试解析。
 * 可复用的快照有名称匹配得到的边、且解析器认为需要重新解析时，也只重跑解析。
 */
async function buildOrReuse(opts: BuildSnapshotOptions, t: Target, waited: boolean): Promise<BuildSnapshotResult> {
  const resolver = resolverOf(opts);
  const snap = opts.store.getSnapshotByKey(t.contentKey);
  const after = reusable(opts.store, t.contentKey) ?? (waited && resolveFailedNotCancelled(snap) ? snap : undefined);
  const dir = snapshotDir(opts.layout, t.contentKey);
  if (after && existsSync(dir) && (await needsReresolve(after, resolver))) return retryResolve(opts, resolver, after, dir);
  if (after) {
    opts.store.touchSnapshot(after.id);
    log.info('snapshot_cache_hit', { kind: t.kind, contentKey: t.contentKey, snapshotId: after.id, waited, resolverStatus: after.resolverStatus });
    return { snapshot: opts.store.getSnapshot(after.id)!, cached: true, resolveRetried: false };
  }
  if (snap?.extractStatus === 'ok' && snap.resolverStatus === 'failed' && existsSync(dir)) {
    return retryResolve(opts, resolver, snap, dir);
  }
  return buildLocked(opts, t, resolver);
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
 * 上次解析失败的快照只重跑解析，名称匹配得到的边按记录可能需要时才持锁、再按解析器的判断重新解析；内容键变了时按文件复用上一个快照的文件和提取结果，
 * 放进快照目录的文件都没变时复用调用边。
 * 构建前获取快照锁，其他进程正在构建同一个快照时等它完成后直接复用。
 */
export async function buildSnapshot(opts: BuildSnapshotOptions): Promise<BuildSnapshotResult> {
  const t = await resolveTarget(opts);
  const hit = reusable(opts.store, t.contentKey);
  if (hit && !mayNeedReresolve(hit.edgeSources)) {
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
  if (result.cached) return result;
  await cleanupSnapshots(opts.store, opts.layout).catch((err: Error) => log.warn('snapshot_cleanup_failed', { error: err.message }));
  return result;
}
