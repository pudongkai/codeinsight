import { execFile } from 'node:child_process';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { EXTRA_TABLES, SCHEMA_VERSION, Store } from '../src/index.js';
import type { NewOverview, OverviewReport, OverviewRow } from '../src/index.js';
import { tempDir } from './helpers/git-repo.js';

const WORKER = path.join(import.meta.dirname, 'helpers', 'overview-worker.mjs');
const run = promisify(execFile);

const NEW: NewOverview = { ref: 'working', snapshotKind: 'working', commitSha: 'abc', contentKey: 'k1', params: { noLlm: false, sendSource: true } };
const REPORT = { schemaVersion: 1 } as unknown as OverviewReport;

function newStore(): Store {
  return new Store(path.join(tempDir('ci-ov-store-'), 'index.db'));
}

/** 开始并结束一条记录，返回 id */
function done(store: Store, hasLlm: boolean, finishedAt: number, input: Partial<NewOverview> = {}): number {
  const r = store.overviews.begin({ ...NEW, ...input }, finishedAt - 1);
  if (!r.ok) throw new Error('unexpected running overview');
  store.overviews.finish(r.id, REPORT, hasLlm, finishedAt);
  return r.id;
}

function tables(dbPath: string): string[] {
  const raw = new DatabaseSync(dbPath);
  const names = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  raw.close();
  return names;
}

describe('extra tables', () => {
  it('adds the tables to an existing version-3 database and keeps its data', () => {
    const dbPath = path.join(tempDir('ci-ov-store-'), 'index.db');
    const s = new Store(dbPath);
    s.createSnapshot('commit', 'abc', 'abc');
    s.finishReview(s.createReview({ base: 'main' }), { ok: true });
    s.close();
    const raw = new DatabaseSync(dbPath);
    for (const t of EXTRA_TABLES) raw.exec(`DROP TABLE ${t}`);
    raw.close();
    expect(tables(dbPath)).not.toContain('overviews');

    const s2 = new Store(dbPath);
    expect(s2.rebuilt).toBe(false);
    expect(tables(dbPath)).toEqual(expect.arrayContaining([...EXTRA_TABLES]));
    expect(s2.listSnapshots()).toHaveLength(1);
    expect(s2.listReviews()).toMatchObject([{ status: 'done', params: { base: 'main' } }]);
    const meta = s2.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
    expect(meta.value).toBe(String(SCHEMA_VERSION));
    s2.close();
  });

  it('opens without a write transaction when all tables exist', () => {
    const dbPath = path.join(tempDir('ci-ov-store-'), 'index.db');
    new Store(dbPath).close();
    const holder = new DatabaseSync(dbPath);
    holder.exec('BEGIN IMMEDIATE');
    try {
      const started = Date.now();
      const s = new Store(dbPath);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(s.rebuilt).toBe(false);
      expect(s.overviews.list()).toEqual([]);
      s.close();
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });
});

describe('overviews table', () => {
  it('round-trips a task through progress, finish and failure', () => {
    const store = newStore();
    const r = store.overviews.begin({ ...NEW, params: { noLlm: false, sendSource: true, provider: 'anthropic', model: 'm', llmIdentity: 'id' } }, 100);
    expect(r.ok).toBe(true);
    const id = (r as { id: number }).id;
    store.overviews.setProgress(id, { step: 'modules', done: 3, total: 14 });
    expect(store.overviews.get(id)).toMatchObject({ status: 'running', pid: process.pid, progress: { step: 'modules', done: 3, total: 14 }, createdAt: 100 });
    store.overviews.finish(id, REPORT, true, 200);
    expect(store.overviews.get(id)).toMatchObject({ status: 'done', hasLlm: true, result: REPORT, progress: null, finishedAt: 200, params: { llmIdentity: 'id' } });
    expect(store.overviews.list()[0]!.result).toBeNull();
    const second = store.overviews.begin(NEW, 300) as { id: number };
    store.overviews.fail(second.id, 'boom', 400);
    expect(store.overviews.get(second.id)).toMatchObject({ status: 'failed', error: 'boom', finishedAt: 400 });
    store.close();
  });

  it('keeps an AI overview as current after a later --no-llm one and reports newerStructureId', () => {
    const store = newStore();
    expect(store.overviews.current()).toEqual({});
    const structureOnly = done(store, false, 1000);
    expect(store.overviews.current().overview?.id).toBe(structureOnly);
    const newerStructure = done(store, false, 1500);
    expect(store.overviews.current()).toMatchObject({ overview: { id: newerStructure } });
    expect(store.overviews.current().newerStructureId).toBeUndefined();

    const named = done(store, true, 2000);
    expect(store.overviews.current()).toEqual({ overview: expect.objectContaining({ id: named, hasLlm: true }) });
    const later = done(store, false, 3000);
    const latest = done(store, false, 4000);
    expect(later).toBeLessThan(latest);
    const cur = store.overviews.current();
    expect(cur.overview?.id).toBe(named);
    expect(cur.newerStructureId).toBe(latest);
    // 提交快照的记录不影响工作区的当前概览
    done(store, true, 5000, { ref: 'v1', snapshotKind: 'commit' });
    expect(store.overviews.current().overview?.id).toBe(named);
    store.close();
  });

  it('picks the last names from the latest AI overview, preferring the same snapshot kind', () => {
    const store = newStore();
    expect(store.overviews.lastNamed('working')).toBeUndefined();
    const commit = done(store, true, 1000, { snapshotKind: 'commit', ref: 'v1' });
    expect(store.overviews.lastNamed('working')?.id).toBe(commit);
    const working = done(store, true, 2000);
    done(store, false, 3000);
    const latestCommit = done(store, true, 4000, { snapshotKind: 'commit', ref: 'v2' });
    expect(store.overviews.lastNamed('working')?.id).toBe(working);
    expect(store.overviews.lastNamed('commit')?.id).not.toBe(commit);
    // 不给快照类型时（--no-llm 的缓存身份）取最近一条，不限类型
    expect(store.overviews.lastNamedParams()).toEqual(store.overviews.get(latestCommit)!.params);
    store.close();
  });

  it('keeps only the 10 most recent finished overviews and never prunes a running one', () => {
    const store = newStore();
    const running = store.overviews.begin(NEW, 1) as { id: number };
    // 同一进程的 running 记录会挡住新任务，这里直接插入已结束的记录
    for (let i = 0; i < 12; i++) {
      store.db.prepare("INSERT INTO overviews(ref, snapshot_kind, commit_sha, content_key, params, status, has_llm, created_at, finished_at) VALUES ('w','working','a','k','{}','done',0,?,?)").run(10 + i, 10 + i);
    }
    store.overviews.prune();
    const rows: OverviewRow[] = store.overviews.list(100);
    expect(rows).toHaveLength(11);
    expect(rows.map((r) => r.id)).toContain(running.id);
    expect(Math.min(...rows.filter((r) => r.status === 'done').map((r) => r.finishedAt!))).toBe(12);
    store.close();
  });
});

describe('overview pruning keeps the AI overview', () => {
  it('keeps the latest AI overview of each snapshot kind after many --no-llm or failed runs', () => {
    const store = newStore();
    const named = done(store, true, 1000);
    const namedCommit = done(store, true, 1100, { snapshotKind: 'commit', ref: 'v1' });
    for (let i = 0; i < 6; i++) done(store, false, 2000 + i);
    for (let i = 0; i < 6; i++) {
      const r = store.overviews.begin(NEW, 3000 + i) as { id: number };
      store.overviews.fail(r.id, 'boom', 3000 + i);
    }
    const ids = store.overviews.list(100).map((r) => r.id);
    expect(ids).toHaveLength(12);
    expect(ids).toEqual(expect.arrayContaining([named, namedCommit]));
    expect(store.overviews.current().overview?.id).toBe(named);
    expect(store.overviews.current().newerStructureId).toBeDefined();
    expect(store.overviews.lastNamed('working')?.id).toBe(named);
    expect(store.overviews.lastNamed('commit')?.id).toBe(namedCommit);
    // 有更新的带 AI 说明的记录后，旧的那条按正常规则清理
    done(store, true, 4000);
    expect(store.overviews.get(named)).toBeUndefined();
    store.close();
  });
});

describe('single overview task', () => {
  it('rejects a second task while the first one is running in this process', () => {
    const store = newStore();
    const other = new Store(store.dbPath);
    const first = store.overviews.begin(NEW);
    expect(first.ok).toBe(true);
    const second = other.overviews.begin(NEW);
    expect(second).toEqual({ ok: false, running: { id: (first as { id: number }).id, pid: process.pid } });
    other.close();
    store.close();
  });

  it('treats a running record with this pid that this process did not start as left over by an exited process', () => {
    const store = newStore();
    store.db.prepare("INSERT INTO overviews(ref, snapshot_kind, commit_sha, content_key, params, status, pid, created_at) VALUES ('working','working','a','k','{}','running',?,1)").run(process.pid);
    const stale = Number((store.db.prepare('SELECT max(id) AS id FROM overviews').get() as { id: number }).id);
    const r = store.overviews.begin(NEW);
    expect(r.ok).toBe(true);
    expect(store.overviews.get(stale)).toMatchObject({ status: 'failed', error: expect.stringContaining('interrupted') });
    // 本进程自己开始的任务结束后不再挡住新任务
    store.overviews.finish((r as { id: number }).id, REPORT, false);
    expect(store.overviews.begin(NEW).ok).toBe(true);
    store.close();
  });

  it('lets only one of two processes start, then fails the running record of the exited process', async () => {
    const store = newStore();
    const [a, b] = await Promise.all([1500, 1500].map((hold) => run(process.execPath, [WORKER, store.dbPath, String(hold)])));
    const results = [a, b].map((r) => JSON.parse(r.stdout) as { pid: number; ok: boolean; id?: number; running?: { id: number; pid: number } });
    const winner = results.find((r) => r.ok)!;
    const loser = results.find((r) => !r.ok)!;
    expect(winner).toBeDefined();
    expect(loser).toBeDefined();
    expect(loser.running).toEqual({ id: winner.id, pid: winner.pid });

    const next = store.overviews.begin(NEW);
    expect(next.ok).toBe(true);
    expect(store.overviews.get(winner.id!)).toMatchObject({ status: 'failed', error: expect.stringContaining('interrupted') });
    store.close();
  });
});
