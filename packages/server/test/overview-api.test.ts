import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@codeinsight/core';
import type { OverviewEstimate, OverviewReport } from '@codeinsight/core';
import { startHttpServer, type RunningHttpServer, type ServerWorkspace } from '../src/index.js';
import { fakeLlmEnv, overviewReply, startFakeLlm, type FakeLlm } from '../../core/test/helpers/fake-llm-server.mjs';
import { apiFor, indexReady, openWorkspace, shopRepo, tempDir, waitFor, writeFiles, type Api } from './helpers/env.js';

const WORKER = path.resolve(import.meta.dirname, '..', '..', 'core', 'test', 'helpers', 'overview-worker.mjs');

interface Job { id: number; status: string; progress: { step: string } | null; error?: string }
interface CurrentOverview { id: number; overview: OverviewReport; stale: boolean; currentContentKey: string | null; snapshotDirty: boolean; newerStructureId?: number }
interface Status { llm: { provider: string; model: string } | null; sendSource: boolean; overview: { id: number; createdAt: number; stale: boolean } | null }

const prevLevel = process.env.CODEINSIGHT_LOG;
let fake: FakeLlm;
/** 每个假 LLM 回复前等这么久，让任务在 running 状态停留一会儿 */
let replyDelayMs = 0;
let repo: string;
let dataDir: string;
let ws: ServerWorkspace;
let server: RunningHttpServer;
let api: Api;
const extra: { ws: ServerWorkspace; server: RunningHttpServer }[] = [];

async function startExtra(opts: { indexOnStart: boolean }): Promise<{ api: Api; ws: ServerWorkspace }> {
  const w = await openWorkspace(repo, dataDir, undefined, fakeLlmEnv(fake.url));
  const s = await startHttpServer({ workspace: w, indexOnStart: opts.indexOnStart });
  extra.push({ ws: w, server: s });
  return { api: apiFor(s), ws: w };
}

async function jobDone(id: number): Promise<Job> {
  return waitFor(async () => {
    const j = (await api<Job>(`/api/overview/jobs/${id}`)).body;
    if (j.status === 'failed') throw new Error(`overview job failed: ${j.error}`);
    return j.status === 'done' ? j : undefined;
  });
}

beforeAll(async () => {
  process.env.CODEINSIGHT_LOG = 'silent';
  fake = await startFakeLlm({ reply: async (req) => (await sleep(replyDelayMs), overviewReply(req)) });
  repo = shopRepo();
  dataDir = tempDir('ci-server-ov-');
  ws = await openWorkspace(repo, dataDir, undefined, fakeLlmEnv(fake.url));
  server = await startHttpServer({ workspace: ws });
  api = apiFor(server);
});

afterAll(async () => {
  for (const e of extra) {
    await e.server.close();
  }
  await server?.close();
  await fake?.close();
  if (prevLevel === undefined) delete process.env.CODEINSIGHT_LOG;
  else process.env.CODEINSIGHT_LOG = prevLevel;
});

describe('overview api', () => {
  it('returns 503 before the index is ready and 404 when there is no overview', async () => {
    const cold = await startExtra({ indexOnStart: false });
    expect((await cold.api('/api/overview/estimate')).body).toMatchObject({ error: 'index_not_ready' });
    const post = await cold.api('/api/overview', { method: 'POST', body: {} });
    expect(post.status).toBe(503);
    const get = await cold.api('/api/overview');
    expect(get.status).toBe(404);
    expect(get.body.error).toBe('overview_not_found');
  });

  it('reports the LLM, the source switch and no overview in /api/status', async () => {
    await indexReady(api);
    const s = (await api<Status>('/api/status')).body;
    expect(s.llm).toEqual({ provider: 'anthropic', model: expect.any(String) });
    expect(s.sendSource).toBe(true);
    expect(s.overview).toBeNull();
  });

  it('estimates without sending requests', async () => {
    const before = fake.requests.length;
    const { status, body } = await api<OverviewEstimate>('/api/overview/estimate');
    expect(status).toBe(200);
    expect(body).toMatchObject({ provider: 'anthropic', sendSource: true, needsConfirm: false, cachedCalls: 0 });
    expect(body.modules).toBeGreaterThan(1);
    expect(body.llmCalls).toBeGreaterThan(body.modules);
    const noSource = (await api<OverviewEstimate>('/api/overview/estimate?noSource=1&noLlm=false')).body;
    expect(noSource.sendSource).toBe(false);
    expect((await api('/api/overview/estimate?noLlm=maybe')).status).toBe(400);
    expect(fake.requests.length).toBe(before);
  });

  it('answers 409 needs_confirm above confirmTokens unless confirmed', async () => {
    const prev = ws.config.overview.confirmTokens;
    ws.config.overview.confirmTokens = 1;
    try {
      const r = await api<{ error: string; estimate: OverviewEstimate }>('/api/overview', { method: 'POST', body: {} });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('needs_confirm');
      expect(r.body.estimate.needsConfirm).toBe(true);
      // --no-llm 不发请求，不需要确认
      const est = (await api<OverviewEstimate>('/api/overview/estimate?noLlm=1')).body;
      expect(est.needsConfirm).toBe(false);
    } finally {
      ws.config.overview.confirmTokens = prev;
    }
  });

  it('runs a job from running to done, reusing the running job for a second request', async () => {
    replyDelayMs = 30;
    const before = fake.requests.length;
    const first = await api<{ id: number }>('/api/overview', { method: 'POST', body: {} });
    expect(first.status).toBe(202);
    const job = (await api<Job>(`/api/overview/jobs/${first.body.id}`)).body;
    expect(job.status).toBe('running');
    const second = await api<{ id: number; reused?: boolean }>('/api/overview', { method: 'POST', body: { confirmed: true } });
    expect(second.body).toEqual({ id: first.body.id, reused: true });
    await jobDone(first.body.id);
    replyDelayMs = 0;
    expect(fake.requests.length).toBeGreaterThan(before);
    const cur = (await api<CurrentOverview>('/api/overview')).body;
    expect(cur.id).toBe(first.body.id);
    expect(cur.stale).toBe(false);
    expect(cur.snapshotDirty).toBe(false);
    expect(cur.currentContentKey).toBe(cur.overview.snapshot.contentKey);
    expect(cur.overview.system?.title).toBe('系统简介');
    expect(cur.overview.modules.every((m) => m.name.startsWith('模块-'))).toBe(true);
    expect((await api<Status>('/api/status')).body.overview).toMatchObject({ id: first.body.id, stale: false });
  });

  it('reads the overview after a restart, by id too', async () => {
    const cur = (await api<CurrentOverview>('/api/overview')).body;
    const restarted = await startExtra({ indexOnStart: false });
    const again = (await restarted.api<CurrentOverview>('/api/overview')).body;
    expect(again.id).toBe(cur.id);
    expect(again.overview.system?.title).toBe('系统简介');
    expect((await restarted.api<Job>(`/api/overview/jobs/${cur.id}`)).body.status).toBe('done');
    expect((await restarted.api<CurrentOverview>(`/api/overview?id=${cur.id}`)).body.id).toBe(cur.id);
    expect((await restarted.api('/api/overview?id=99999')).status).toBe(404);
    expect((await restarted.api('/api/overview?id=abc')).status).toBe(400);
    expect((await restarted.api('/api/overview/jobs/99999')).status).toBe(404);
  });

  it('keeps the AI overview current after a --no-llm run and returns newerStructureId', async () => {
    const named = (await api<CurrentOverview>('/api/overview')).body.id;
    // 缓存命中的说明也算 AI 说明；清掉缓存后 --no-llm 只得到结构部分
    rmSync(ws.layout.llmCacheDir, { recursive: true, force: true });
    const before = fake.requests.length;
    const r = await api<{ id: number }>('/api/overview', { method: 'POST', body: { noLlm: true } });
    expect(r.status).toBe(202);
    await jobDone(r.body.id);
    expect(fake.requests.length).toBe(before);
    const cur = (await api<CurrentOverview>('/api/overview')).body;
    expect(cur.id).toBe(named);
    expect(cur.newerStructureId).toBe(r.body.id);
    const structure = (await api<CurrentOverview>(`/api/overview?id=${r.body.id}`)).body;
    expect(structure.overview.llm).toBeUndefined();
  });

  it('answers 409 overview_running while another process holds a running record', async () => {
    let worker: ChildProcess | undefined;
    try {
      worker = spawn(process.execPath, [WORKER, ws.layout.dbPath, '60000'], { stdio: ['ignore', 'pipe', 'inherit'] });
      const line = await new Promise<string>((resolve) => worker!.stdout!.once('data', (d: Buffer) => resolve(d.toString())));
      const held = JSON.parse(line) as { pid: number; ok: boolean };
      expect(held.ok).toBe(true);
      const r = await api<{ error: string; pid: number }>('/api/overview', { method: 'POST', body: { confirmed: true } });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ error: 'overview_running', pid: held.pid });
    } finally {
      if (worker && worker.exitCode === null) {
        const exited = new Promise((r) => worker!.once('exit', r));
        worker.kill();
        await exited;
      }
    }
    // 持有进程退出后，它的 running 记录在下次开始时改为 failed
    const r = await api<{ id: number }>('/api/overview', { method: 'POST', body: { noLlm: true } });
    expect(r.status).toBe(202);
    await jobDone(r.body.id);
  });

  it('marks the overview stale after the code changes and the index is rebuilt', async () => {
    const cur = (await api<CurrentOverview>('/api/overview')).body;
    writeFiles(repo, { 'app/tiny/extra.py': 'def added():\n    return 1\n' });
    const job = (await api<{ id: number }>('/api/index', { method: 'POST' })).body;
    await waitFor(async () => {
      const s = (await api<{ index: { job: { id: number; status: string } } }>('/api/status')).body;
      return s.index.job.id === job.id && s.index.job.status === 'done' ? true : undefined;
    });
    const after = (await api<CurrentOverview>('/api/overview')).body;
    expect(after.id).toBe(cur.id);
    expect(after.stale).toBe(true);
    expect(after.currentContentKey).not.toBe(after.overview.snapshot.contentKey);
    expect((await api<Status>('/api/status')).body.overview?.stale).toBe(true);
    expect(after.snapshotDirty).toBe(false);
    // 在含未提交改动的代码上生成的概览：snapshotDirty 为 true
    const structure = (await api<{ id: number }>('/api/overview', { method: 'POST', body: { noLlm: true } })).body;
    await jobDone(structure.id);
    expect((await api<CurrentOverview>(`/api/overview?id=${structure.id}`)).body.snapshotDirty).toBe(true);
  });

  it('marks running records left by an exited process as failed when the server starts', async () => {
    const worker = spawn(process.execPath, [WORKER, ws.layout.dbPath, '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    worker.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    await new Promise((r) => worker.once('exit', r));
    const left = JSON.parse(out) as { ok: boolean; id: number };
    expect(left.ok).toBe(true);
    expect(ws.store.overviews.get(left.id)?.status).toBe('running');
    const restarted = await startExtra({ indexOnStart: false });
    const job = (await restarted.api<Job>(`/api/overview/jobs/${left.id}`)).body;
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/interrupted/);
  });

  it('waits for the running overview job when the server closes', async () => {
    const w = await openWorkspace(repo, dataDir, undefined, fakeLlmEnv(fake.url));
    const other = await startHttpServer({ workspace: w });
    try {
      const a = apiFor(other);
      await indexReady(a);
      replyDelayMs = 30;
      const r = await a<{ id: number }>('/api/overview', { method: 'POST', body: { confirmed: true } });
      expect(r.status).toBe(202);
      expect(w.store.overviews.get(r.body.id)?.status).toBe('running');
      await other.close();
      // 关闭服务时它的 Store 也被关闭，重新打开读结果
      const store = new Store(w.layout.dbPath);
      expect(store.overviews.get(r.body.id)?.status).toBe('done');
      store.close();
    } finally {
      replyDelayMs = 0;
    }
  });
});
