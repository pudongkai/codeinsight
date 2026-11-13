import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildSnapshot, cleanupSnapshots, initDataDir, loadConfig, ScipPythonResolver, setLogSink, snapshotDir,
  SnapshotCancelledError, Store,
} from '../src/index.js';
import type { BuildSnapshotResult, CodeInsightConfig, DataDirLayout, ResolveInput, ResolveResult, Resolver } from '../src/index.js';
import { isProcessAlive } from '../src/store/process.js';
import { commitAll, git, tempDir, writeFiles } from './helpers/git-repo.js';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const FAKE_SCIP = path.join(import.meta.dirname, 'helpers', 'fake-scip.mjs');

function fixtureRepo(name: string, extra: Record<string, string> = {}): string {
  const repo = tempDir('ci-incr-');
  cpSync(path.join(FIXTURES, name), repo, { recursive: true });
  writeFiles(repo, extra);
  git(repo, 'init', '-q', '-b', 'main');
  commitAll(repo, 'init');
  return repo;
}

/** 记录调用次数的 resolver，实际解析交给 scip-python 或指定的 resolver */
class CountingResolver implements Resolver {
  readonly name = 'counting';
  calls = 0;
  constructor(private readonly inner: Resolver = new ScipPythonResolver(), readonly version?: string) {}
  resolve(input: ResolveInput): Promise<ResolveResult> {
    this.calls++;
    return this.inner.resolve(input);
  }
}

class FailingResolver implements Resolver {
  readonly name = 'failing';
  resolve(): Promise<ResolveResult> {
    return Promise.reject(new Error('boom'));
  }
}

interface Env {
  repo: string;
  store: Store;
  layout: DataDirLayout;
  config: CodeInsightConfig;
  resolver: CountingResolver;
  build(opts?: { config?: CodeInsightConfig; resolver?: Resolver; signal?: AbortSignal }): Promise<BuildSnapshotResult>;
}

async function setup(repo: string): Promise<Env> {
  const config = await loadConfig(repo, { dataDir: tempDir('ci-incr-data-'), env: {} });
  const layout = await initDataDir(config.dataDir);
  const store = new Store(layout.dbPath);
  const resolver = new CountingResolver();
  const build: Env['build'] = (o = {}) =>
    buildSnapshot({ repo, store, layout, config: o.config ?? config, resolver: o.resolver ?? resolver, signal: o.signal });
  return { repo, store, layout, config, resolver, build };
}

function sortedJson(rows: object[]): string[] {
  return rows.map((r) => {
    const rest: Record<string, unknown> = { ...r };
    delete rest.snapshotId;
    return JSON.stringify(rest);
  }).sort();
}

/** 快照的 files、symbols、entries、edges，去掉 snapshot_id 后排序 */
function dump(store: Store, id: number): Record<string, string[]> {
  return {
    files: sortedJson(store.getFiles(id)),
    symbols: sortedJson(store.getSymbols(id)),
    entries: sortedJson(store.getEntries(id)),
    edges: sortedJson(store.getEdges(id)),
  };
}

/** 同一工作区在新数据目录里全量建一次（没有上一个快照，也没有提取缓存） */
async function fullDump(repo: string): Promise<Record<string, string[]>> {
  const env = await setup(repo);
  try {
    const { snapshot } = await env.build();
    expect(env.store.extractCache.count()).toBeGreaterThan(0);
    return dump(env.store, snapshot.id);
  } finally {
    env.store.close();
  }
}

const logLines: string[] = [];
let restoreSink: ((line: string) => void) | undefined;
const logLevel = process.env.CODEINSIGHT_LOG;
beforeAll(() => {
  process.env.CODEINSIGHT_LOG = 'info';
  restoreSink = setLogSink((line) => logLines.push(line));
});
afterAll(() => {
  if (restoreSink) setLogSink(restoreSink);
  if (logLevel === undefined) delete process.env.CODEINSIGHT_LOG;
  else process.env.CODEINSIGHT_LOG = logLevel;
});

/** 最近一条 event 日志里的数字字段 */
function lastLogNumber(event: string, field: string): number | undefined {
  const line = logLines.findLast((l) => l.includes(` ${event} `));
  const m = line ? new RegExp(` ${field}=(\\d+)`).exec(line) : null;
  return m ? Number(m[1]) : undefined;
}

describe('incremental snapshot build', () => {
  it('gives the same rows as a full build after two successive changes, re-extracting only the changed file', async () => {
    const env = await setup(fixtureRepo('py-basic'));
    await env.build();
    writeFiles(env.repo, { 'pkg/service.py': `${readFileSync(path.join(env.repo, 'pkg/service.py'), 'utf8')}\n\ndef added():\n    return 1\n` });
    const second = await env.build();
    expect(lastLogNumber('extract_done', 'cacheMisses')).toBe(1);
    expect(dump(env.store, second.snapshot.id)).toEqual(await fullDump(env.repo));

    // 只改视图文件：没变的 urls.py 产生的 Django 入口仍正确
    writeFiles(env.repo, { 'mysite/views.py': `${readFileSync(path.join(env.repo, 'mysite/views.py'), 'utf8')}\n\ndef extra(request):\n    return None\n` });
    const third = await env.build();
    expect(lastLogNumber('extract_done', 'cacheMisses')).toBe(1);
    const rows = dump(env.store, third.snapshot.id);
    expect(rows).toEqual(await fullDump(env.repo));
    expect(env.store.getEntries(third.snapshot.id).filter((e) => e.framework === 'django')).toHaveLength(2);
    env.store.close();
  }, 120_000);

  it('re-evaluates model kinds in unchanged files when only the base class file changes', async () => {
    const env = await setup(fixtureRepo('py-shop', {
      'app/shapes/base.py': 'from pydantic import BaseModel\n\n\nclass Base(BaseModel):\n    pass\n',
      'app/shapes/item.py': 'from app.shapes.base import Base\n\n\nclass Item(Base):\n    name: str\n',
    }));
    const itemKind = (id: number) => env.store.findSymbolsByName(id, 'Item').find((s) => s.path === 'app/shapes/item.py')!.modelKind;
    const first = await env.build();
    expect(itemKind(first.snapshot.id)).toBe('pydantic');
    writeFiles(env.repo, { 'app/shapes/base.py': 'class Base:\n    pass\n' });
    const second = await env.build();
    expect(lastLogNumber('extract_done', 'cacheMisses')).toBe(1);
    expect(itemKind(second.snapshot.id)).toBeNull();
    expect(dump(env.store, second.snapshot.id)).toEqual(await fullDump(env.repo));
    env.store.close();
  }, 120_000);

  it('misses the cache for files whose test classification changed', async () => {
    const env = await setup(fixtureRepo('py-basic'));
    await env.build();
    writeFiles(env.repo, { 'pkg/cli.py': `${readFileSync(path.join(env.repo, 'pkg/cli.py'), 'utf8')}\n# changed\n` });
    await env.build({ config: { ...env.config, testGlobs: [...env.config.testGlobs, 'pkg/repo.py'] } });
    expect(lastLogNumber('extract_done', 'cacheMisses')).toBe(2);
    env.store.close();
  }, 120_000);
});

describe('snapshot directory hard links', () => {
  it('links unchanged files to the previous snapshot and falls back to writing', async () => {
    const env = await setup(fixtureRepo('py-basic'));
    const first = await env.build();
    writeFiles(env.repo, { 'pkg/service.py': '# v2\n' });
    const second = await env.build();
    const dir1 = snapshotDir(env.layout, first.snapshot.contentKey);
    const dir2 = snapshotDir(env.layout, second.snapshot.contentKey);
    const ino = (dir: string, rel: string) => statSync(path.join(dir, rel)).ino;
    expect(ino(dir2, 'pkg/repo.py')).toBe(ino(dir1, 'pkg/repo.py'));
    expect(ino(dir2, 'pkg/service.py')).not.toBe(ino(dir1, 'pkg/service.py'));
    expect(lastLogNumber('snapshot_copied', 'written')).toBe(1);

    // 改工作区文件不影响旧快照目录
    const before = readFileSync(path.join(dir2, 'pkg/repo.py'), 'utf8');
    writeFiles(env.repo, { 'pkg/repo.py': '# changed\n' });
    // 上一个快照目录里的文件被删掉时改为写入
    rmSync(path.join(dir2, 'pkg/tasks.py'));
    const third = await env.build();
    const dir3 = snapshotDir(env.layout, third.snapshot.contentKey);
    expect(readFileSync(path.join(dir2, 'pkg/repo.py'), 'utf8')).toBe(before);
    expect(readFileSync(path.join(dir1, 'pkg/repo.py'), 'utf8')).toBe(before);
    expect(readFileSync(path.join(dir3, 'pkg/repo.py'), 'utf8')).toBe('# changed\n');
    expect(readFileSync(path.join(dir3, 'pkg/tasks.py'), 'utf8')).toBe(readFileSync(path.join(env.repo, 'pkg/tasks.py'), 'utf8'));
    expect(lastLogNumber('snapshot_copied', 'written')).toBe(2);
    env.store.close();
  }, 120_000);
});

describe('reusing call edges', () => {
  it('skips the resolver when only non-Python files changed, and runs it for Python or project config changes', async () => {
    const env = await setup(fixtureRepo('py-basic', { 'pyproject.toml': '[project]\nname = "basic"\n' }));
    const first = await env.build();
    expect(env.resolver.calls).toBe(1);

    writeFiles(env.repo, { 'README.md': '# changed\n' });
    const readme = await env.build();
    expect(env.resolver.calls).toBe(1);
    expect(readme.snapshot).toMatchObject({ extractStatus: 'ok', resolverStatus: 'ok' });
    expect(sortedJson(env.store.getEdges(readme.snapshot.id))).toEqual(sortedJson(env.store.getEdges(first.snapshot.id)));
    expect(logLines.some((l) => l.includes(' resolve_reused ') && l.includes(first.snapshot.contentKey))).toBe(true);

    writeFiles(env.repo, { 'pkg/tasks.py': '# changed\n' });
    await env.build();
    expect(env.resolver.calls).toBe(2);

    writeFiles(env.repo, { 'pyproject.toml': '[project]\nname = "basic2"\n' });
    await env.build();
    expect(env.resolver.calls).toBe(3);
    env.store.close();
  }, 120_000);

  it('does not reuse edges produced by a different resolver version or extract code version', async () => {
    const env = await setup(fixtureRepo('py-basic'));
    const first = await env.build();
    expect(env.store.getEdgesCodeHash(first.snapshot.id)).toBeDefined();
    writeFiles(env.repo, { 'README.md': '# v2\n' });
    const upgraded = new CountingResolver(new ScipPythonResolver(), 'v2');
    const second = await env.build({ resolver: upgraded });
    expect(upgraded.calls).toBe(1);

    // 上一个快照的调用边来自另一个版本的提取代码（符号 id 可能不同）
    env.store.setEdgesCodeHash(second.snapshot.id, 'older-code');
    writeFiles(env.repo, { 'README.md': '# v3\n' });
    await env.build({ resolver: upgraded });
    expect(upgraded.calls).toBe(2);
    env.store.close();
  }, 120_000);

  it('does not reuse edges from a snapshot whose resolution failed', async () => {
    const env = await setup(fixtureRepo('py-basic'));
    const failed = await env.build({ resolver: new FailingResolver() });
    expect(failed.snapshot.resolverStatus).toBe('failed');
    writeFiles(env.repo, { 'README.md': '# changed\n' });
    const next = await env.build();
    expect(env.resolver.calls).toBe(1);
    expect(next.snapshot.resolverStatus).toBe('ok');
    env.store.close();
  }, 120_000);
});

describe('extract cache storage', () => {
  it('prunes cache rows that the kept snapshots no longer use', async () => {
    const env = await setup(fixtureRepo('py-basic'));
    const first = await env.build();
    writeFiles(env.repo, { 'README.md': '# changed\n' });
    const second = await env.build();
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    env.store.touchSnapshot(first.snapshot.id, now - 10 * day);
    env.store.extractCache.put([{ key: 'stale', path: 'old.py', data: '{}' }], now - 10 * day);
    const before = env.store.extractCache.count();
    await cleanupSnapshots(env.store, env.layout, { keep: 1, recentMs: 0, now });
    expect(env.store.getSnapshot(first.snapshot.id)).toBeUndefined();
    expect(env.store.getSnapshot(second.snapshot.id)).toBeDefined();
    expect(env.store.extractCache.lookup(['stale']).size).toBe(0);
    expect(env.store.extractCache.count()).toBe(before - 1);
    env.store.close();
  }, 120_000);

  it('treats a failing cache lookup as all misses and ignores a failing cache write', async () => {
    const env = await setup(fixtureRepo('py-basic'));
    await env.build();
    const busy = () => { throw new Error('database is locked'); };
    const lookup = vi.spyOn(env.store.extractCache, 'lookup').mockImplementation(busy);
    const put = vi.spyOn(env.store.extractCache, 'put').mockImplementation(busy);
    try {
      writeFiles(env.repo, { 'README.md': '# changed\n' });
      const second = await env.build();
      expect(lookup).toHaveBeenCalled();
      expect(put).toHaveBeenCalled();
      expect(lastLogNumber('extract_done', 'cacheHits')).toBe(0);
      expect(logLines.filter((l) => l.includes(' extract_cache_failed ')).length).toBeGreaterThanOrEqual(2);
      expect(dump(env.store, second.snapshot.id)).toEqual(await fullDump(env.repo));
    } finally {
      lookup.mockRestore();
      put.mockRestore();
      env.store.close();
    }
  }, 120_000);

  it('adds the extract_cache table to an existing database and keeps its data', () => {
    const dbPath = path.join(tempDir('ci-incr-db-'), 'index.db');
    const old = new Store(dbPath);
    old.createSnapshot('working', 'abc', 'abc-key');
    old.db.exec('DROP TABLE extract_cache');
    old.close();
    const reopened = new Store(dbPath);
    expect(reopened.getSnapshotByKey('abc-key')).toBeDefined();
    reopened.extractCache.put([{ key: 'k', path: 'a.py', data: '{}' }]);
    expect(reopened.extractCache.lookup(['k']).get('k')).toBe('{}');
    reopened.close();
  });
});

describe('cancelling a snapshot build', () => {
  it('stops during extraction without calling the resolver, and the next build completes', async () => {
    const env = await setup(fixtureRepo('py-shop'));
    const controller = new AbortController();
    const sink = setLogSink((line) => {
      logLines.push(line);
      if (line.includes(' snapshot_copied ')) controller.abort();
    });
    let err: unknown;
    try {
      await env.build({ signal: controller.signal });
    } catch (e) {
      err = e;
    } finally {
      setLogSink(sink);
    }
    expect(err).toBeInstanceOf(SnapshotCancelledError);
    expect((err as SnapshotCancelledError).stage).toBe('extract');
    expect(env.resolver.calls).toBe(0);
    expect(env.store.listSnapshots()[0]).toMatchObject({ extractStatus: 'pending' });
    expect(logLines.some((l) => l.includes(' snapshot_build_cancelled ') && l.includes('stage=extract'))).toBe(true);

    const again = await env.build();
    expect(again.snapshot).toMatchObject({ extractStatus: 'ok', resolverStatus: 'ok' });
    env.store.close();
  }, 120_000);

  it('retries resolution after waiting for a build that was cancelled, instead of returning it as cached', async () => {
    const env = await setup(fixtureRepo('py-basic'));
    const pidFile = path.join(tempDir('ci-incr-pid-'), 'pid');
    const prevPidEnv = process.env.FAKE_SCIP_PID_FILE;
    process.env.FAKE_SCIP_PID_FILE = pidFile;
    const controller = new AbortController();
    try {
      const first = env.build({ resolver: new ScipPythonResolver({ bin: FAKE_SCIP }), signal: controller.signal });
      while (!existsSync(pidFile) || readFileSync(pidFile, 'utf8') === '') await sleep(20);
      const waiting = env.build();
      await sleep(300);
      controller.abort();
      await expect(first).rejects.toMatchObject({ stage: 'resolve' });
      const second = await waiting;
      expect(logLines.some((l) => l.includes(' snapshot_lock_waiting '))).toBe(true);
      expect(second).toMatchObject({ cached: false, resolveRetried: true, snapshot: { resolverStatus: 'ok' } });
      expect(env.store.getEdges(second.snapshot.id).length).toBeGreaterThan(0);
    } finally {
      if (prevPidEnv === undefined) delete process.env.FAKE_SCIP_PID_FILE;
      else process.env.FAKE_SCIP_PID_FILE = prevPidEnv;
    }
    env.store.close();
  }, 120_000);

  it('stops while waiting for the snapshot lock when already aborted', async () => {
    const env = await setup(fixtureRepo('py-basic'));
    await expect(env.build({ signal: AbortSignal.abort() })).rejects.toMatchObject({ stage: 'lock' });
    env.store.close();
  });

  it('kills a running scip-python, removes its temporary output, and marks the resolver failed', async () => {
    const env = await setup(fixtureRepo('py-basic'));
    const pidFile = path.join(tempDir('ci-incr-pid-'), 'pid');
    const prevPidEnv = process.env.FAKE_SCIP_PID_FILE;
    process.env.FAKE_SCIP_PID_FILE = pidFile;
    const controller = new AbortController();
    try {
      const building = env.build({ resolver: new ScipPythonResolver({ bin: FAKE_SCIP }), signal: controller.signal });
      while (!existsSync(pidFile) || readFileSync(pidFile, 'utf8') === '') await sleep(20);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      controller.abort();
      await expect(building).rejects.toMatchObject({ stage: 'resolve' });
      expect(isProcessAlive(pid)).toBe(false);
      expect(readdirSync(env.layout.scipDir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
      expect(env.store.listSnapshots()[0]).toMatchObject({ extractStatus: 'ok', resolverStatus: 'failed', resolverError: 'cancelled' });
    } finally {
      if (prevPidEnv === undefined) delete process.env.FAKE_SCIP_PID_FILE;
      else process.env.FAKE_SCIP_PID_FILE = prevPidEnv;
    }
    const again = await env.build();
    expect(again).toMatchObject({ resolveRetried: true, snapshot: { resolverStatus: 'ok' } });
    env.store.close();
  }, 120_000);
});
