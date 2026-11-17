import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Store } from './db.js';
import { log } from '../log.js';
import { isProcessAlive } from './process.js';

export const LOCK_STALE_MS = 30 * 60 * 1000;
export const KEEP_SNAPSHOTS = 8;
export const RECENT_USE_MS = 10 * 60 * 1000;
/** 提取缓存比保留下来的快照里最早用到的那个再多保留这么久 */
export const EXTRACT_CACHE_GRACE_MS = 24 * 60 * 60 * 1000;

export interface DataDirLayout {
  root: string;
  dbPath: string;
  snapshotsDir: string;
  scipDir: string;
  emptyEnvPath: string;
  llmCacheDir: string;
  locksDir: string;
}

export function dataDirLayout(root: string): DataDirLayout {
  return {
    root,
    dbPath: path.join(root, 'index.db'),
    snapshotsDir: path.join(root, 'snapshots'),
    scipDir: path.join(root, 'scip'),
    emptyEnvPath: path.join(root, 'scip', 'empty-env.json'),
    llmCacheDir: path.join(root, 'llm-cache'),
    locksDir: path.join(root, 'locks'),
  };
}

export function snapshotDir(layout: DataDirLayout, contentKey: string): string {
  return path.join(layout.snapshotsDir, contentKey);
}

export function scipPath(layout: DataDirLayout, contentKey: string): string {
  return path.join(layout.scipDir, `${contentKey}.scip`);
}

/** 按语言的 SCIP 索引缓存 `<contentKey>.<language>.scip`（各根目录的索引合并后，文档路径相对快照根目录） */
export function languageScipPath(layout: DataDirLayout, contentKey: string, language: string): string {
  return path.join(layout.scipDir, `${contentKey}.${language}.scip`);
}

/** 一个快照在 scip 目录里的缓存文件：`<contentKey>.scip`，以及按语言的 `<contentKey>.<language>.scip` 和 `.json` */
function isSnapshotScipFile(name: string, contentKey: string): boolean {
  if (name === `${contentKey}.scip`) return true;
  return name.startsWith(`${contentKey}.`) && /^[a-z]+\.(scip|json)$/.test(name.slice(contentKey.length + 1));
}

async function removeSnapshotScipFiles(layout: DataDirLayout, contentKey: string): Promise<void> {
  const names = await readdir(layout.scipDir).catch(() => [] as string[]);
  await Promise.all(names.filter((n) => isSnapshotScipFile(n, contentKey)).map((n) => rm(path.join(layout.scipDir, n), { force: true })));
}

/**
 * 初始化数据目录。目录里写一个内容为 `*` 的 .gitignore，git 不会把数据目录列为未跟踪文件，
 * 也不需要改用户的 .gitignore。
 */
export async function initDataDir(root: string): Promise<DataDirLayout> {
  const layout = dataDirLayout(root);
  for (const d of [layout.root, layout.snapshotsDir, layout.scipDir, layout.llmCacheDir, layout.locksDir]) {
    await mkdir(d, { recursive: true });
  }
  const gi = path.join(root, '.gitignore');
  if (!existsSync(gi)) await writeFile(gi, '*\n');
  if (!existsSync(layout.emptyEnvPath)) await writeFile(layout.emptyEnvPath, '[]\n');
  await removeStaleScipTemps(layout);
  return layout;
}

/** Rust 解析的运行目录 `codeinsight-rust-<contentKey 前 16 位>.<pid>.<随机 6 位>`，建在 rustRunBaseCandidates() 之一下 */
export const RUST_RUN_DIR_PREFIX = 'codeinsight-rust-';

/**
 * Rust 运行目录的上级候选，按优先顺序：`$XDG_CACHE_HOME/codeinsight/rust-run`（设了绝对路径时），
 * `~/.cache/codeinsight/rust-run`。前一个所在的缓存目录不是当前用户私有时用后一个
 */
export function rustRunBaseCandidates(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const caches = [env.XDG_CACHE_HOME && path.isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : undefined, path.join(home, '.cache')];
  return [...new Set(caches.filter((c): c is string => c !== undefined))].map((c) => path.join(c, 'codeinsight', 'rust-run'));
}
const RUST_RUN_DIR = /^codeinsight-rust-[^.]*\.(\d+)\.[A-Za-z0-9]{6}$/;

function isStalePid(pid: number): boolean {
  return pid !== process.pid && !isProcessAlive(pid);
}

/** 数据目录里的临时输出 `<key>.scip.<pid>.tmp`：写它的进程已不存在时删除 */
async function removeStaleScipTempFiles(layout: DataDirLayout): Promise<string[]> {
  const names = await readdir(layout.scipDir).catch(() => [] as string[]);
  const removed: string[] = [];
  for (const name of names) {
    const m = /\.scip\.(\d+)\.tmp$/.exec(name);
    if (!m || !isStalePid(Number(m[1]))) continue;
    await rm(path.join(layout.scipDir, name), { force: true });
    removed.push(name);
  }
  return removed;
}

/** Rust 运行目录：属于当前用户、建它的进程已不存在时递归删除 */
async function removeStaleRustRunDirs(runBase: string): Promise<string[]> {
  const names = await readdir(runBase).catch(() => [] as string[]);
  const uid = process.getuid?.();
  const removed: string[] = [];
  for (const name of names) {
    const m = RUST_RUN_DIR.exec(name);
    if (!m || !isStalePid(Number(m[1]))) continue;
    const st = await lstat(path.join(runBase, name)).catch(() => undefined);
    if (!st?.isDirectory() || (uid !== undefined && st.uid !== uid)) continue;
    await rm(path.join(runBase, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/**
 * 删除进程被强行结束时留下的临时文件：数据目录里的 `<key>.scip.<pid>.tmp`，
 * 以及 runBase（默认 rustRunBaseCandidates() 里的各目录）里的 Rust 运行目录
 */
export async function removeStaleScipTemps(layout: DataDirLayout, runBase?: string): Promise<string[]> {
  const removed = await removeStaleScipTempFiles(layout);
  for (const base of runBase === undefined ? rustRunBaseCandidates() : [runBase]) removed.push(...await removeStaleRustRunDirs(base));
  if (removed.length > 0) log.info('scip_temp_removed', { files: removed.length });
  return removed;
}

// ---- pyright exclude 检查 ----

function stripJsonComments(s: string): string {
  return s.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str: string | undefined) => str ?? '');
}

function readPyrightJsonExclude(text: string): string[] | undefined {
  try {
    const cleaned = stripJsonComments(text).replace(/,(\s*[}\]])/g, '$1');
    const obj = JSON.parse(cleaned) as { exclude?: unknown };
    return Array.isArray(obj.exclude) ? obj.exclude.map(String) : undefined;
  } catch {
    return undefined;
  }
}

/** 从 pyproject.toml 的 [tool.pyright] 段读 exclude 数组（只处理字符串数组这一种写法） */
export function readPyprojectPyrightExclude(text: string): string[] | undefined {
  const section = /^\s*\[tool\.pyright\]\s*$/m.exec(text);
  if (!section) return undefined;
  const rest = text.slice(section.index + section[0].length);
  const nextSection = /^\s*\[/m.exec(rest);
  const body = nextSection ? rest.slice(0, nextSection.index) : rest;
  const m = /^\s*exclude\s*=\s*\[([\s\S]*?)\]/m.exec(body);
  if (!m) return undefined;
  const items: string[] = [];
  for (const s of m[1]!.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'/g)) items.push(s[1] ?? s[2] ?? '');
  return items;
}

/** 把 pyright 的 glob（`**`、`*`、`?`）转成匹配相对路径的正则 */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        re += '(?:.*/)?';
        i++;
      } else {
        re += '.*';
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  // pyright 的 exclude 匹配目录时也排除目录下的所有文件
  return new RegExp(`^${re}(/.*)?$`);
}

function excludesDataDir(patterns: string[], dataDirRel: string): boolean {
  const name = dataDirRel.replace(/^\.\//, '').replace(/\/+$/, '');
  const probe = `${name}/x.py`;
  return patterns.some((p) => globToRegExp(p.replace(/^\.\//, '').replace(/\/+$/, '')).test(probe));
}

/**
 * 仓库里自定义了 pyright exclude 时，Pyright 默认的排除规则不再生效，数据目录会被扫描。
 * 这种情况下返回提示文字（只提示，不改用户文件）。
 */
export async function checkPyrightExclude(repo: string, dataDirRel: string): Promise<string[]> {
  const warnings: string[] = [];
  const pyrightJson = await readFile(path.join(repo, 'pyrightconfig.json'), 'utf8').catch(() => undefined);
  if (pyrightJson !== undefined) {
    const ex = readPyrightJsonExclude(pyrightJson);
    if (ex && !excludesDataDir(ex, dataDirRel)) {
      warnings.push(`pyrightconfig.json defines "exclude" without ${dataDirRel}; add "${dataDirRel}" to its exclude list`);
    }
  }
  const pyproject = await readFile(path.join(repo, 'pyproject.toml'), 'utf8').catch(() => undefined);
  if (pyproject !== undefined) {
    const ex = readPyprojectPyrightExclude(pyproject);
    if (ex && !excludesDataDir(ex, dataDirRel)) {
      warnings.push(`pyproject.toml [tool.pyright] defines exclude without ${dataDirRel}; add "${dataDirRel}" to exclude`);
    }
  }
  return warnings;
}

// ---- 快照锁 ----
//
// 锁文件内容先写进临时文件，再用 link 原子地放到锁路径上，读到的锁文件内容总是完整的。
// 删除锁（释放、回收失效锁）都在一个短暂持有的 guard 文件保护下进行，并在删除前重新确认
// 锁还是原来那一把，避免误删其他进程刚建好的新锁。

interface LockInfo {
  pid: number;
  startedAt: number;
  token: string;
}

interface LockState {
  /** 内容无法解析时为 undefined */
  info?: LockInfo;
  mtimeMs: number;
}

/** 内容损坏的锁文件超过这个时间按失效处理 */
const CORRUPT_LOCK_GRACE_MS = 5_000;
/** guard 只在删除锁的瞬间持有，超过这个时间说明持有者已异常退出 */
const GUARD_STALE_MS = 10_000;

export function lockPath(layout: DataDirLayout, contentKey: string): string {
  return path.join(layout.locksDir, `${contentKey}.lock`);
}

function newLockInfo(): LockInfo {
  return { pid: process.pid, startedAt: Date.now(), token: randomUUID() };
}

async function readLockState(file: string): Promise<LockState | undefined> {
  let raw: string;
  let mtimeMs: number;
  try {
    [raw, { mtimeMs }] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return { info: parseLockInfo(raw), mtimeMs };
}

function parseLockInfo(raw: string): LockInfo | undefined {
  try {
    const v = JSON.parse(raw) as Partial<LockInfo> | null;
    if (v && typeof v.pid === 'number' && typeof v.startedAt === 'number') {
      return { pid: v.pid, startedAt: v.startedAt, token: String(v.token ?? '') };
    }
  } catch {
    // 内容损坏，按 undefined 处理
  }
  return undefined;
}

function isLockStale(state: LockState, now = Date.now()): boolean {
  if (!state.info) return now - state.mtimeMs > CORRUPT_LOCK_GRACE_MS;
  return !isProcessAlive(state.info.pid) || now - state.info.startedAt > LOCK_STALE_MS;
}

function sameLock(a: LockState, b: LockState): boolean {
  return a.info && b.info ? a.info.token === b.info.token && a.info.pid === b.info.pid : a.info === b.info;
}

/** 原子地创建锁文件；已存在时返回 false */
async function createExclusive(file: string, info: LockInfo): Promise<boolean> {
  const tmp = `${file}.${info.token}.tmp`;
  await writeFile(tmp, JSON.stringify(info));
  try {
    await link(tmp, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    await rm(tmp, { force: true });
  }
}

/** 在 guard 保护下执行删除锁相关的操作 */
async function withLockGuard<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const guard = `${file}.guard`;
  const me = newLockInfo();
  while (!(await createExclusive(guard, me))) {
    const g = await readLockState(guard);
    if (g && Date.now() - g.mtimeMs > GUARD_STALE_MS) {
      log.warn('lock_guard_reclaimed', { guard, holderPid: g.info?.pid });
      await rm(guard, { force: true });
      continue;
    }
    await sleep(10);
  }
  try {
    return await fn();
  } finally {
    const g = await readLockState(guard);
    if (g?.info?.token === me.token) await rm(guard, { force: true });
  }
}

/** 锁仍是 seen 那一把且已失效时删除它 */
async function reclaimStaleLock(file: string, seen: LockState, contentKey: string): Promise<void> {
  await withLockGuard(file, async () => {
    const cur = await readLockState(file);
    if (!cur || !sameLock(cur, seen) || !isLockStale(cur)) return;
    await rm(file, { force: true });
    log.warn('snapshot_lock_reclaimed', {
      contentKey,
      holderPid: cur.info?.pid,
      reason: cur.info ? (isProcessAlive(cur.info.pid) ? 'expired' : 'holder_exited') : 'corrupt',
    });
  });
}

/** 只删除自己持有的锁 */
async function releaseOwnLock(file: string, token: string, contentKey: string): Promise<void> {
  await withLockGuard(file, async () => {
    const cur = await readLockState(file);
    if (cur?.info?.token === token) {
      await rm(file, { force: true });
      log.debug('snapshot_lock_released', { contentKey });
    } else {
      log.warn('snapshot_lock_lost', { contentKey, currentPid: cur?.info?.pid });
    }
  });
}

export async function isLocked(layout: DataDirLayout, contentKey: string): Promise<boolean> {
  const state = await readLockState(lockPath(layout, contentKey));
  return state !== undefined && !isLockStale(state);
}

export interface LockHandle {
  /** 是否等待过其他进程；为 true 时调用方应先检查结果能否直接复用 */
  waited: boolean;
  release(): Promise<void>;
}

export interface AcquireOptions {
  pollMs?: number;
  timeoutMs?: number;
  /** 等锁期间中止时抛出 signal.reason */
  signal?: AbortSignal;
}

/** 获取快照构建锁；已被其他存活进程持有时等待，持有者已退出或超过 30 分钟时认为锁失效并回收 */
export async function acquireSnapshotLock(
  layout: DataDirLayout,
  contentKey: string,
  opts: AcquireOptions = {},
): Promise<LockHandle> {
  const file = lockPath(layout, contentKey);
  const pollMs = opts.pollMs ?? 200;
  const deadline = Date.now() + (opts.timeoutMs ?? LOCK_STALE_MS + 60_000);
  let waited = false;
  await mkdir(layout.locksDir, { recursive: true });
  for (;;) {
    opts.signal?.throwIfAborted();
    const me = newLockInfo();
    if (await createExclusive(file, me)) {
      log.debug('snapshot_lock_acquired', { contentKey, waited });
      return { waited, release: () => releaseOwnLock(file, me.token, contentKey) };
    }
    const seen = await readLockState(file);
    if (!seen) continue;
    if (isLockStale(seen)) {
      await reclaimStaleLock(file, seen, contentKey);
      continue;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for snapshot lock ${contentKey}`);
    if (!waited) log.info('snapshot_lock_waiting', { contentKey, holderPid: seen.info?.pid });
    waited = true;
    await sleep(pollMs, undefined, { signal: opts.signal });
  }
}

// ---- 快照清理 ----

export interface CleanupOptions {
  keep?: number;
  recentMs?: number;
  now?: number;
}

/** 只保留最近使用的 keep 个快照；持有锁或 recentMs 内用过的快照不清理 */
export async function cleanupSnapshots(store: Store, layout: DataDirLayout, opts: CleanupOptions = {}): Promise<number[]> {
  const keep = opts.keep ?? KEEP_SNAPSHOTS;
  const recentMs = opts.recentMs ?? RECENT_USE_MS;
  const now = opts.now ?? Date.now();
  const removed: number[] = [];
  for (const snap of store.listSnapshots().slice(keep)) {
    if (now - snap.lastUsedAt < recentMs) continue;
    if (await isLocked(layout, snap.contentKey)) continue;
    store.deleteSnapshot(snap.id);
    await rm(snapshotDir(layout, snap.contentKey), { recursive: true, force: true });
    await removeSnapshotScipFiles(layout, snap.contentKey);
    removed.push(snap.id);
  }
  if (removed.length > 0) log.info('snapshots_cleaned', { removed: removed.length });
  pruneExtractCache(store);
  await removeStaleScipTemps(layout);
  return removed;
}

/** 删除比保留下来的快照里最早的 last_used_at 还早一天以上的提取缓存 */
function pruneExtractCache(store: Store): void {
  const kept = store.listSnapshots();
  if (kept.length === 0) return;
  const oldest = Math.min(...kept.map((s) => s.lastUsedAt));
  const pruned = store.extractCache.pruneBefore(oldest - EXTRACT_CACHE_GRACE_MS);
  if (pruned > 0) log.info('extract_cache_pruned', { rows: pruned });
}
