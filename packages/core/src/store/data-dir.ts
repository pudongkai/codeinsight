import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Store } from './db.js';
import { isProcessAlive } from './process.js';

export const LOCK_STALE_MS = 30 * 60 * 1000;
export const KEEP_SNAPSHOTS = 8;
export const RECENT_USE_MS = 10 * 60 * 1000;

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
  return layout;
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

function excludesDataDir(patterns: string[], dataDirRel: string): boolean {
  const name = dataDirRel.replace(/^\.\//, '').replace(/\/+$/, '');
  return patterns.some((p) => {
    const q = p.replace(/^\.\//, '').replace(/\/+$/, '').replace(/^\*\*\//, '');
    return q === name || q === `${name}/**` || q === `**/${name}`;
  });
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

interface LockInfo {
  pid: number;
  startedAt: number;
}

export function lockPath(layout: DataDirLayout, contentKey: string): string {
  return path.join(layout.locksDir, `${contentKey}.lock`);
}

async function readLock(file: string): Promise<LockInfo | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as LockInfo;
  } catch {
    return undefined;
  }
}

function isLockStale(info: LockInfo | undefined, now = Date.now()): boolean {
  // 刚创建、还没写入内容的锁文件读出来是 undefined，这时不当作失效
  if (!info) return false;
  return !isProcessAlive(info.pid) || now - info.startedAt > LOCK_STALE_MS;
}

export async function isLocked(layout: DataDirLayout, contentKey: string): Promise<boolean> {
  const file = lockPath(layout, contentKey);
  if (!existsSync(file)) return false;
  return !isLockStale(await readLock(file));
}

export interface LockHandle {
  /** 是否等待过其他进程；为 true 时调用方应先检查结果能否直接复用 */
  waited: boolean;
  release(): Promise<void>;
}

export interface AcquireOptions {
  pollMs?: number;
  timeoutMs?: number;
}

async function tryCreateLock(file: string): Promise<boolean> {
  try {
    const fh = await open(file, 'wx');
    await fh.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() } satisfies LockInfo));
    await fh.close();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
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
    if (await tryCreateLock(file)) {
      return { waited, release: () => rm(file, { force: true }) };
    }
    if (isLockStale(await readLock(file))) {
      await rm(file, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for snapshot lock ${contentKey}`);
    waited = true;
    await sleep(pollMs);
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
    await rm(scipPath(layout, snap.contentKey), { force: true });
    removed.push(snap.id);
  }
  return removed;
}
