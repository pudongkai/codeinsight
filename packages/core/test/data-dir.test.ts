import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Store,
  acquireSnapshotLock,
  checkPyrightExclude,
  cleanupSnapshots,
  initDataDir,
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

/** 在子进程里按同样的约定持有锁 holdMs 毫秒后释放 */
function holdLockInChild(file: string, holdMs: number): Promise<void> {
  const script = `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(file)}, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: 'wx' });
    process.stdout.write('locked\\n');
    setTimeout(() => { fs.rmSync(${JSON.stringify(file)}); process.exit(0); }, ${holdMs});
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => child.stdout.once('data', () => resolve()));
}

describe('snapshot locks', () => {
  it('waits while another live process holds the lock', async () => {
    const layout = await initDataDir(tempDir());
    await holdLockInChild(lockPath(layout, 'k1'), 600);
    const t0 = Date.now();
    const h = await acquireSnapshotLock(layout, 'k1', { pollMs: 50 });
    expect(h.waited).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
    await h.release();
    expect(existsSync(lockPath(layout, 'k1'))).toBe(false);
  });

  it('reclaims a lock whose holder has exited', async () => {
    const layout = await initDataDir(tempDir());
    writeFileSync(lockPath(layout, 'k2'), JSON.stringify({ pid: 999999999, startedAt: Date.now() }));
    const h = await acquireSnapshotLock(layout, 'k2', { pollMs: 50, timeoutMs: 2000 });
    expect(h.waited).toBe(false);
    expect(JSON.parse(readFileSync(lockPath(layout, 'k2'), 'utf8')).pid).toBe(process.pid);
    await h.release();
  });

  it('cleanup keeps recent, locked and the newest snapshots', async () => {
    const layout = await initDataDir(tempDir());
    const store = new Store(layout.dbPath);
    const old = Date.now() - 60 * 60 * 1000;
    for (let i = 0; i < 12; i++) {
      const s = store.createSnapshot('commit', `sha${i}`, `sha${i}`, old + i);
      mkdirSync(snapshotDir(layout, s.contentKey), { recursive: true });
    }
    store.touchSnapshot(store.getSnapshotByKey('sha0')!.id); // 刚用过
    const lock = await acquireSnapshotLock(layout, 'sha1'); // 持锁中
    const removed = await cleanupSnapshots(store, layout);
    const remaining = store.listSnapshots().map((s) => s.contentKey).sort();
    // 保留 sha0（刚用过）和最近的 7 个；剩下 sha1..sha4 中 sha1 持锁
    expect(removed).toHaveLength(3);
    expect(remaining).toContain('sha0');
    expect(remaining).toContain('sha1');
    expect(existsSync(snapshotDir(layout, 'sha2'))).toBe(false);
    await lock.release();
    store.close();
  });
});
