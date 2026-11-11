import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Store,
  acquireSnapshotLock,
  checkPyrightExclude,
  cleanupSnapshots,
  initDataDir,
  isLocked,
  lockPath,
  readPyprojectPyrightExclude,
  snapshotDir,
} from '../src/index.js';
import { git, initRepo, tempDir } from './helpers/git-repo.js';

describe('data dir', () => {
  it('is invisible to git status after init', async () => {
    const repo = initRepo({ 'a.py': 'x = 1\n' });
    const layout = await initDataDir(path.join(repo, '.codeinsight'));
    writeFileSync(path.join(layout.snapshotsDir, 'junk.py'), 'x = 1\n');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(readFileSync(layout.emptyEnvPath, 'utf8').trim()).toBe('[]');
  });

  it('warns when pyrightconfig.json has custom exclude without the data dir', async () => {
    const repo = tempDir();
    writeFileSync(path.join(repo, 'pyrightconfig.json'), '{\n // c\n "exclude": ["build"],\n}');
    expect(await checkPyrightExclude(repo, '.codeinsight')).toHaveLength(1);
    writeFileSync(path.join(repo, 'pyrightconfig.json'), '{"exclude": ["build", ".codeinsight"]}');
    expect(await checkPyrightExclude(repo, '.codeinsight')).toHaveLength(0);
    for (const pattern of ['.codeinsight/*', '**/.*', '**/.codeinsight/**', './.codeinsight/']) {
      writeFileSync(path.join(repo, 'pyrightconfig.json'), JSON.stringify({ exclude: [pattern] }));
      expect(await checkPyrightExclude(repo, '.codeinsight'), pattern).toHaveLength(0);
    }
    writeFileSync(path.join(repo, 'pyrightconfig.json'), JSON.stringify({ exclude: ['**/node_modules', 'foo.codeinsight'] }));
    expect(await checkPyrightExclude(repo, '.codeinsight')).toHaveLength(1);
    writeFileSync(path.join(repo, 'pyrightconfig.json'), '{"include": ["src"]}');
    expect(await checkPyrightExclude(repo, '.codeinsight')).toHaveLength(0);
  });

  it('checks pyproject.toml [tool.pyright] exclude', async () => {
    const toml = '[project]\nname="x"\n[tool.pyright]\nexclude = [\n  "build",\n  "**/.codeinsight",\n]\n[tool.other]\nexclude=["y"]\n';
    expect(readPyprojectPyrightExclude(toml)).toEqual(['build', '**/.codeinsight']);
    const repo = tempDir();
    writeFileSync(path.join(repo, 'pyproject.toml'), toml);
    expect(await checkPyrightExclude(repo, '.codeinsight')).toHaveLength(0);
    writeFileSync(path.join(repo, 'pyproject.toml'), '[tool.pyright]\nexclude = ["build"]\n');
    expect(await checkPyrightExclude(repo, '.codeinsight')).toHaveLength(1);
  });
});

const WORKER = path.join(import.meta.dirname, 'helpers', 'lock-worker.mjs');

function runWorker(dataDir: string, key: string, holdMs: number, events: string, mode = ''): Promise<void> {
  const child = spawn(process.execPath, [WORKER, dataDir, key, String(holdMs), events, mode], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
  });
}

function readIntervals(events: string): [number, number][] {
  return readFileSync(events, 'utf8').trim().split('\n').map((l) => {
    const [, s, e] = l.split(' ');
    return [Number(s), Number(e)];
  });
}

describe('snapshot locks', () => {
  it('lets only one of several competing processes hold the lock at a time', async () => {
    const layout = await initDataDir(tempDir());
    const events = path.join(tempDir(), 'events.txt');
    for (let round = 0; round < 3; round++) {
      await Promise.all(Array.from({ length: 6 }, () => runWorker(layout.root, 'k', 30, events)));
    }
    const intervals = readIntervals(events).sort((a, b) => a[0] - b[0]);
    expect(intervals).toHaveLength(18);
    for (let i = 1; i < intervals.length; i++) {
      expect(intervals[i]![0]).toBeGreaterThanOrEqual(intervals[i - 1]![1]);
    }
    expect(existsSync(lockPath(layout, 'k'))).toBe(false);
  });

  it('waits while another live process holds the lock', async () => {
    const layout = await initDataDir(tempDir());
    const events = path.join(tempDir(), 'events.txt');
    const holder = runWorker(layout.root, 'k1', 600, events);
    while (!existsSync(lockPath(layout, 'k1'))) await sleep(10);
    expect(await isLocked(layout, 'k1')).toBe(true);
    const h = await acquireSnapshotLock(layout, 'k1', { pollMs: 20 });
    const acquiredAt = Date.now();
    await holder;
    expect(h.waited).toBe(true);
    expect(acquiredAt).toBeGreaterThanOrEqual(readIntervals(events)[0]![1] - 5);
    await h.release();
    expect(existsSync(lockPath(layout, 'k1'))).toBe(false);
  });

  it('reclaims a lock whose holder process has exited', async () => {
    const layout = await initDataDir(tempDir());
    await runWorker(layout.root, 'k2', 0, path.join(tempDir(), 'e'), 'die');
    expect(existsSync(lockPath(layout, 'k2'))).toBe(true);
    expect(await isLocked(layout, 'k2')).toBe(false);
    const h = await acquireSnapshotLock(layout, 'k2', { pollMs: 20, timeoutMs: 2000 });
    expect(h.waited).toBe(false);
    expect(JSON.parse(readFileSync(lockPath(layout, 'k2'), 'utf8')).pid).toBe(process.pid);
    await h.release();
  });

  it('treats an old corrupt lock file as stale but a fresh one as held', async () => {
    const layout = await initDataDir(tempDir());
    const file = lockPath(layout, 'k3');
    writeFileSync(file, '');
    expect(await isLocked(layout, 'k3')).toBe(true);
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
    expect(await isLocked(layout, 'k3')).toBe(false);
    const h = await acquireSnapshotLock(layout, 'k3', { pollMs: 20, timeoutMs: 2000 });
    expect(h.waited).toBe(false);
    await h.release();
  });

  it('does not delete a lock it no longer owns', async () => {
    const layout = await initDataDir(tempDir());
    const file = lockPath(layout, 'k4');
    const h = await acquireSnapshotLock(layout, 'k4');
    const other = JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: 'someone-else' });
    writeFileSync(file, other);
    await h.release();
    expect(readFileSync(file, 'utf8')).toBe(other);
  });

  it('cleanup keeps the newest and locked snapshots', async () => {
    const layout = await initDataDir(tempDir());
    const store = new Store(layout.dbPath);
    const old = Date.now() - 60 * 60 * 1000;
    for (let i = 0; i < 12; i++) {
      const s = store.createSnapshot('commit', `sha${i}`, `sha${i}`, old + i);
      mkdirSync(snapshotDir(layout, s.contentKey), { recursive: true });
    }
    const lock = await acquireSnapshotLock(layout, 'sha1');
    const removed = await cleanupSnapshots(store, layout);
    const remaining = store.listSnapshots().map((s) => s.contentKey).sort();
    // 保留最近的 8 个（sha4..sha11）；sha0..sha3 中 sha1 持锁
    expect(removed).toHaveLength(3);
    expect(remaining).toEqual(['sha1', 'sha10', 'sha11', 'sha4', 'sha5', 'sha6', 'sha7', 'sha8', 'sha9']);
    expect(existsSync(snapshotDir(layout, 'sha0'))).toBe(false);
    await lock.release();
    store.close();
  });

  it('cleanup keeps snapshots used recently even beyond the newest 8', async () => {
    const layout = await initDataDir(tempDir());
    const store = new Store(layout.dbPath);
    const now = Date.now();
    for (let i = 0; i < 12; i++) store.createSnapshot('commit', `sha${i}`, `sha${i}`, now - 60_000 + i);
    expect(await cleanupSnapshots(store, layout, { now })).toHaveLength(0);
    expect(store.listSnapshots()).toHaveLength(12);
    store.close();
  });
});
