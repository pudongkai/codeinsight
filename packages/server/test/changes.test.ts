import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { excludeDirs, resolveRef, setLogSink, workingContentKey } from '@codeinsight/core';
import type { Resolver, SnapshotRow } from '@codeinsight/core';
import { ChangeDetector } from '../src/changes.js';
import type { IndexJob, IndexJobs } from '../src/jobs/index-jobs.js';
import { startHttpServer, type RunningHttpServer, type ServerWorkspace } from '../src/index.js';
import { apiFor, git, indexReady, openWorkspace, tempDir, waitFor, writeFiles, type Api } from './helpers/env.js';

interface Status {
  index: { job: { id: number; reason: string; status: string } | null };
  snapshot: { id: number; contentKey: string } | null;
  changes: { checkedAt: number | null; codeChanged: boolean; autoReindex: boolean };
}

const resolver: Resolver = { name: 'none', resolve: async () => ({ edges: [] }) };
const prevLevel = process.env.CODEINSIGHT_LOG;
const logLines: string[] = [];
let restoreSink: ((line: string) => void) | undefined;

function makeRepo(): string {
  const repo = tempDir('ci-changes-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  writeFiles(repo, { 'a.py': 'def a():\n    return 1\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

beforeAll(() => {
  process.env.CODEINSIGHT_LOG = 'info';
  restoreSink = setLogSink((line) => logLines.push(line));
});

afterAll(() => {
  if (restoreSink) setLogSink(restoreSink);
  if (prevLevel === undefined) delete process.env.CODEINSIGHT_LOG;
  else process.env.CODEINSIGHT_LOG = prevLevel;
});

/** 假的建索引任务：当前快照的内容键固定，start 返回立即失败的任务 */
function fakeIndexJobs(snap: Pick<SnapshotRow, 'contentKey'> | undefined) {
  const started: string[] = [];
  const jobs = {
    runningJob: () => undefined,
    current: () => snap,
    start: (reason: string) => {
      started.push(reason);
      const job = { id: started.length, reason, status: 'failed', error: 'boom', startedAt: Date.now() } as IndexJob;
      job.done = Promise.resolve(job);
      return job;
    },
  };
  return { started, jobs: jobs as unknown as IndexJobs };
}

describe('ChangeDetector', () => {
  let ws: ServerWorkspace;
  beforeAll(async () => {
    ws = await openWorkspace(makeRepo(), tempDir('ci-changes-data-'));
  });
  afterAll(() => ws.store.close());

  const check = async (d: ChangeDetector, autoReindex: boolean) => {
    d.maybeCheck(autoReindex);
    await d.settled();
    await new Promise((r) => setImmediate(r));
  };

  it('does not compare before the first snapshot and throttles checks', async () => {
    const none = new ChangeDetector({ ws, indexJobs: fakeIndexJobs(undefined).jobs, isClosing: () => false }, 0);
    await check(none, true);
    expect(none.view(true)).toMatchObject({ codeChanged: false, autoReindex: true });
    expect(none.view(true).checkedAt).not.toBeNull();

    const slow = new ChangeDetector({ ws, indexJobs: fakeIndexJobs({ contentKey: 'other' }).jobs, isClosing: () => false }, 60_000);
    await check(slow, false);
    const first = slow.view(false).checkedAt;
    await check(slow, false);
    expect(slow.view(false).checkedAt).toBe(first);
  });

  it('starts one automatic index for a stable key and does not retry a failed key', async () => {
    const fake = fakeIndexJobs({ contentKey: 'old-key' });
    const d = new ChangeDetector({ ws, indexJobs: fake.jobs, isClosing: () => false }, 0);
    await check(d, false);
    expect(d.view(false)).toMatchObject({ codeChanged: true, autoReindexFailed: false });
    await check(d, false);
    expect(fake.started).toEqual([]);
    await check(d, true);
    expect(fake.started).toEqual(['auto']);
    await check(d, true);
    await check(d, true);
    expect(fake.started).toEqual(['auto']);
    expect(d.view(true)).toMatchObject({ codeChanged: true, autoReindexFailed: true });
    expect(logLines.some((l) => l.includes('index_auto_start'))).toBe(true);
    // 代码又变了：新的内容键连续两次相同后再自动开始
    writeFiles(ws.repo, { 'b.py': 'x = 2\n' });
    await check(d, true);
    expect(fake.started).toEqual(['auto']);
    expect(d.view(true).autoReindexFailed).toBe(false);
    await check(d, true);
    expect(fake.started).toEqual(['auto', 'auto']);
  });

  it('reports no change as soon as the current snapshot matches the last checked key', async () => {
    const snap = { contentKey: 'old-key' };
    const d = new ChangeDetector({ ws, indexJobs: fakeIndexJobs(snap).jobs, isClosing: () => false }, 60_000);
    await check(d, false);
    expect(d.view(false).codeChanged).toBe(true);
    snap.contentKey = await workingContentKey(ws.repo, await resolveRef(ws.repo, 'HEAD'), excludeDirs(ws.config, ws.repo));
    expect(d.view(false).codeChanged).toBe(false);
  });

  it('logs and recovers when reading the index state throws', async () => {
    const jobs = { runningJob: () => undefined, current: () => { throw new Error('store closed'); } } as unknown as IndexJobs;
    const d = new ChangeDetector({ ws, indexJobs: jobs, isClosing: () => false }, 0);
    d.maybeCheck(true);
    await expect(d.settled()).resolves.toBeUndefined();
    expect(logLines.some((l) => l.includes('change_check_failed') && l.includes('store closed'))).toBe(true);
    d.maybeCheck(true);
    await d.settled();
  });

  it('keeps the last result when git fails and skips checks while closing', async () => {
    const fake = fakeIndexJobs({ contentKey: 'k' });
    const broken = { ...ws, repo: tempDir('ci-changes-nogit-') };
    const d = new ChangeDetector({ ws: broken, indexJobs: fake.jobs, isClosing: () => false }, 0);
    await check(d, true);
    expect(d.view(true)).toEqual({ checkedAt: null, codeChanged: false, autoReindex: true, autoReindexFailed: false });
    expect(logLines.some((l) => l.includes('change_check_failed'))).toBe(true);
    const closing = new ChangeDetector({ ws, indexJobs: fake.jobs, isClosing: () => true }, 0);
    await check(closing, true);
    expect(closing.view(true).checkedAt).toBeNull();
  });
});

describe('code change detection over HTTP', () => {
  let repo: string;
  let ws: ServerWorkspace;
  let server: RunningHttpServer;
  let api: Api;

  beforeAll(async () => {
    repo = makeRepo();
    ws = await openWorkspace(repo, tempDir('ci-changes-http-data-'), resolver);
    server = await startHttpServer({ workspace: ws, env: {}, dirPicker: { tool: null }, changeCheckIntervalMs: 50 });
    api = apiFor(server);
    await indexReady(api);
  });
  afterAll(async () => {
    await server?.close();
  });

  const status = async () => (await api<Status>('/api/status')).body;
  const until = (pred: (s: Status) => boolean) => waitFor(async () => {
    const s = await status();
    return pred(s) ? s : undefined;
  }, 30_000);

  it('reports codeChanged after an edit and clears it after reindexing', async () => {
    await until((s) => s.changes.checkedAt !== null && !s.changes.codeChanged);
    writeFiles(repo, { 'a.py': 'def a():\n    return 2\n' });
    await until((s) => s.changes.codeChanged);
    const job = await api<{ id: number }>('/api/index', { method: 'POST' });
    expect(job.status).toBeLessThan(300);
    await indexReady(api);
    await until((s) => !s.changes.codeChanged && s.index.job?.status === 'done');
  });

  it('reindexes automatically when autoReindex is on', async () => {
    await api('/api/settings', { method: 'POST', body: { autoReindex: true } });
    const before = (await status()).snapshot!.contentKey;
    writeFiles(repo, { 'c.py': 'def c():\n    return 3\n' });
    const s = await until((x) => x.index.job?.reason === 'auto' && x.index.job.status === 'done' && !x.changes.codeChanged);
    expect(s.changes.autoReindex).toBe(true);
    expect(s.snapshot!.contentKey).not.toBe(before);
    await api('/api/settings', { method: 'POST', body: { autoReindex: false } });
  });
});
