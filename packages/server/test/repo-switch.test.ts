import { request as httpRequest } from 'node:http';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readUserSettings, Store } from '@codeinsight/core';
import type { Resolver } from '@codeinsight/core';
import { startHttpServer, type HttpServerOptions, type RunningHttpServer, type ServerWorkspace } from '../src/index.js';
import type { RunPicker } from '../src/dir-picker.js';
import { RepoClosedError } from '../src/jobs/closed.js';
import { markClosing } from '../src/repo-context.js';
import { fakeLlmEnv, firstUserText, overviewReply, startFakeLlm, type FakeLlm } from '../../core/test/helpers/fake-llm-server.mjs';
import { apiFor, git, openWorkspace, postStream, request, shopRepo, tempDir, waitFor, writeFiles, type Api } from './helpers/env.js';

interface Status {
  repo: string | null; repoGen: number | null; repoLocked: boolean;
  index: { job: { id: number; status: string; cached?: boolean; error?: string } | null };
  snapshot: { id: number; dirty: boolean } | null;
  overview: { id: number } | null;
}
interface RepoTaskView { kind: string; id: number; cancellable: boolean }
interface ErrorBody { error: string; tasks?: RepoTaskView[]; repoGen?: number | null }

/** 解析器：hold 为 true 时停住，直到 release 或被中止 */
function gatedResolver() {
  let hold = false;
  let release: () => void = () => undefined;
  let gate = Promise.resolve();
  const state = {
    calls: 0,
    hold() {
      hold = true;
      gate = new Promise<void>((r) => (release = r));
    },
    release() {
      hold = false;
      release();
    },
    resolver: {
      name: 'gated',
      resolve: async ({ signal }) => {
        state.calls++;
        if (hold) {
          await new Promise<void>((resolve, reject) => {
            void gate.then(resolve);
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        }
        return { edges: [] };
      },
    } as Resolver,
  };
  return state;
}

function makeRepo(files: Record<string, string> = { 'a.py': 'def a():\n    return b()\n\n\ndef b():\n    return 1\n' }): string {
  const repo = tempDir('ci-switch-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  writeFiles(repo, files);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return realpathSync(repo);
}

const prevLevel = process.env.CODEINSIGHT_LOG;
let fake: FakeLlm;
/** 概览的假 LLM 回复在这个 promise 完成前停住 */
let overviewGate: Promise<void> = Promise.resolve();
let releaseOverview: () => void = () => undefined;
const servers: RunningHttpServer[] = [];
const gated = gatedResolver();

/** 测试用的打开方式：不读本机环境变量和用户设置，数据目录在仓库里的 .codeinsight */
function testOpen(repo: string, dataDir?: string): Promise<ServerWorkspace> {
  return openWorkspace(repo, dataDir ?? path.join(repo, '.codeinsight'), gated.resolver, fakeLlmEnv(fake.url));
}

async function start(opts: Partial<HttpServerOptions> & { repo?: string } = {}): Promise<{ server: RunningHttpServer; api: Api }> {
  const workspace = opts.workspace ?? (opts.repo ? await testOpen(opts.repo) : undefined);
  const server = await startHttpServer({ openWorkspace: testOpen, ...opts, workspace });
  servers.push(server);
  return { server, api: apiFor(server) };
}

function openRepo(api: Api, p: unknown, cancelRunning?: boolean) {
  return api<Record<string, unknown> & ErrorBody>('/api/repo', { method: 'POST', body: { path: p, ...(cancelRunning !== undefined ? { cancelRunning } : {}) } });
}

async function indexDone(api: Api): Promise<Status> {
  return waitFor(async () => {
    const s = (await api<Status>('/api/status')).body;
    return s.index.job?.status === 'done' && s.snapshot ? s : undefined;
  });
}

beforeAll(async () => {
  process.env.CODEINSIGHT_LOG = 'silent';
  fake = await startFakeLlm({
    reply: async (req) => {
      if (firstUserText(req).startsWith('hang')) return { text: 'partial answer', hang: true };
      await overviewGate;
      return overviewReply(req);
    },
  });
});

afterEach(async () => {
  gated.release();
  releaseOverview();
  for (const s of servers.splice(0)) await s.close();
});

afterAll(async () => {
  await fake?.close();
  if (prevLevel === undefined) delete process.env.CODEINSIGHT_LOG;
  else process.env.CODEINSIGHT_LOG = prevLevel;
});

describe('starting without a repository', () => {
  it('reports no repository in /api/status, rejects repository APIs with 409 no_repo and still lists repositories', async () => {
    const { api } = await start();
    const s = (await api<Status>('/api/status')).body;
    expect(s).toMatchObject({ repo: null, repoGen: null, repoLocked: false, snapshot: null, overview: null, index: { job: null } });
    for (const [p, method] of [['/api/symbols/search?q=a', 'GET'], ['/api/entries', 'GET'], ['/api/chat/sessions', 'GET'], ['/api/index', 'POST'], ['/api/overview', 'GET']] as const) {
      const r = await api<ErrorBody>(p, { method });
      expect(r.status, p).toBe(409);
      expect(r.body.error).toBe('no_repo');
    }
    const repos = (await api<{ current: unknown; startupRepo: unknown; locked: boolean; recent: unknown[] }>('/api/repos')).body;
    expect(repos).toMatchObject({ current: null, startupRepo: null, locked: false });
  });
});

describe('opening a repository', () => {
  it('rejects bad paths with 400', async () => {
    const { api } = await start();
    const file = path.join(tempDir('ci-switch-file-'), 'f.txt');
    writeFileSync(file, 'x');
    const plain = tempDir('ci-switch-plain-');
    const cases: [unknown, string][] = [
      ['', 'invalid_param'], [42, 'invalid_param'], ['x'.repeat(5000), 'invalid_param'], ['relative/dir', 'invalid_param'],
      [path.join(plain, 'missing'), 'path_not_found'], [file, 'not_directory'], [plain, 'not_git_repo'],
    ];
    for (const [p, code] of cases) {
      const r = await openRepo(api, p);
      expect(r.status, String(p).slice(0, 40)).toBe(400);
      expect(r.body.error).toBe(code);
    }
    expect((await api<Status>('/api/status')).body.repo).toBeNull();
  });

  it('opens the repository root for a subdirectory, starts indexing and records it as recent; the same repository is reused', async () => {
    const repo = makeRepo();
    mkdirSync(path.join(repo, 'sub'));
    const { api } = await start();
    const r = await openRepo(api, path.join(repo, 'sub'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ repo, repoGen: 1, dataDir: path.join(repo, '.codeinsight'), reused: false });
    const s = await indexDone(api);
    expect(s).toMatchObject({ repo, repoGen: 1 });
    expect(s.snapshot?.dirty).toBe(false);
    expect((await readUserSettings()).recentRepos[0]?.path).toBe(repo);
    const repos = (await api<{ current: { path: string; gen: number }; recent: { path: string; exists: boolean }[] }>('/api/repos')).body;
    expect(repos.current).toMatchObject({ path: repo, gen: 1 });
    expect(repos.recent[0]).toMatchObject({ path: repo, exists: true });
    const again = await openRepo(api, repo);
    expect(again.body).toMatchObject({ repoGen: 1, reused: true });
  });

  it('reports uncommitted changes in the current snapshot as dirty', async () => {
    const repo = makeRepo();
    writeFiles(repo, { 'b.py': 'x = 1\n' });
    const { api } = await start({ repo });
    expect((await indexDone(api)).snapshot?.dirty).toBe(true);
  });

  it('removes entries from the recent list', async () => {
    const repo = makeRepo();
    const { api } = await start({ repo });
    expect((await readUserSettings()).recentRepos.map((r) => r.path)).toContain(repo);
    expect((await api(`/api/repos/recent?path=${encodeURIComponent(repo)}`, { method: 'DELETE' })).status).toBe(204);
    expect((await readUserSettings()).recentRepos.map((r) => r.path)).not.toContain(repo);
    expect((await api(`/api/repos/recent?path=${encodeURIComponent(repo)}`, { method: 'DELETE' })).status).toBe(204);
  });
});

describe('switching repositories', () => {
  it('refuses while a review or an overview runs, even with cancelRunning', async () => {
    const a = shopRepo();
    const b = makeRepo();
    const { api } = await start({ repo: a });
    await indexDone(api);
    const callsBefore = gated.calls;
    overviewGate = new Promise((resolve) => (releaseOverview = resolve));
    const ov = await api<{ id: number }>('/api/overview', { method: 'POST', body: { confirmed: true } });
    expect(ov.status).toBe(202);
    // 工作区有新改动，审查要建新的工作区快照，停在解析这一步
    writeFiles(a, { 'extra_mod.py': 'def z():\n    return 1\n' });
    gated.hold();
    const rv = await api<{ id: number }>('/api/reviews', { method: 'POST', body: { working: true, noLlm: true } });
    expect(rv.status).toBe(202);
    await waitFor(async () => (gated.calls > callsBefore ? true : undefined));
    for (const cancel of [false, true]) {
      const r = await openRepo(api, b, cancel);
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('repo_busy');
      const kinds = r.body.tasks!.map((t) => t.kind);
      expect(kinds).toEqual(expect.arrayContaining(['overview', 'review']));
      expect(r.body.tasks!.find((t) => t.kind === 'review')?.cancellable).toBe(false);
    }
    expect((await api<Status>('/api/status')).body.repo).toBe(a);
  });

  it('cancels a running answer with cancelRunning and saves it as cancelled', async () => {
    const a = makeRepo();
    const b = makeRepo();
    const { server, api } = await start({ repo: a });
    await indexDone(api);
    const session = (await api<{ id: number }>('/api/chat/sessions', { method: 'POST', body: {} })).body.id;
    const stream = await postStream(server, `/api/chat/sessions/${session}/messages`, { question: 'hang please' });
    await waitFor(async () => (stream.lines.some((l) => l.includes('"text"')) ? true : undefined), 30_000);
    const old = server.app()!;
    const busy = await openRepo(api, b);
    expect(busy.body).toMatchObject({ error: 'repo_busy', tasks: [{ kind: 'ask', id: session, cancellable: true }] });
    const r = await openRepo(api, b, true);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ repo: b, repoGen: 2 });
    await stream.ended;
    const store = new Store(old.ws.layout.dbPath);
    try {
      expect(store.chats.messages(session).at(-1)).toMatchObject({ role: 'assistant', meta: { status: 'cancelled' } });
    } finally {
      store.close();
    }
  });

  it('cancels a running index job with cancelRunning', async () => {
    const a = makeRepo();
    const b = makeRepo();
    gated.hold();
    const { server, api } = await start({ repo: a });
    await waitFor(async () => (gated.calls > 0 ? true : undefined));
    const old = server.app()!;
    const job = old.indexJobs.runningJob()!;
    expect(job).toBeDefined();
    const busy = await openRepo(api, b);
    expect(busy.body).toMatchObject({ error: 'repo_busy', tasks: [{ kind: 'index', id: job.id, cancellable: true }] });
    const r = await openRepo(api, b, true);
    expect(r.status).toBe(200);
    expect(old.indexJobs.get(job.id)).toMatchObject({ status: 'failed', error: 'cancelled' });
    expect(server.app()!.ws.repo).toBe(b);
  });

  it('closes the old Store only after its in-flight requests finish', async () => {
    const a = makeRepo();
    const b = makeRepo();
    const { server, api } = await start({ repo: a });
    await indexDone(api);
    const old = server.app()!;
    // 请求体还没发完，请求一直在处理中
    const req = httpRequest({
      host: '127.0.0.1', port: server.port, path: '/api/chat/sessions', method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.token}` },
    });
    const response = new Promise<number>((resolve, reject) => {
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
    });
    req.write('{"title":');
    await waitFor(async () => (old.inflight > 0 ? true : undefined));
    expect((await openRepo(api, b)).status).toBe(200);
    await sleep(200);
    expect(() => old.ws.store.listReviews()).not.toThrow();
    req.end('"kept"}');
    expect(await response).toBe(201);
    await waitFor(async () => {
      try {
        old.ws.store.listReviews();
        return undefined;
      } catch {
        return true;
      }
    });
    expect(old.inflight).toBe(0);
  });

  it('does not count requests that need no repository, so a waiting folder picker does not hold up a switch', async () => {
    const a = makeRepo();
    const b = makeRepo();
    let close: () => void = () => undefined;
    const runPicker: RunPicker = () => new Promise((resolve) => (close = () => resolve({ exitCode: 1, stdout: '', stderr: '' })));
    const { server, api } = await start({ repo: a, dirPicker: { tool: 'zenity', runPicker } });
    await indexDone(api);
    const old = server.app()!;
    const picking = api('/api/repo/pick-dir', { method: 'POST' });
    await sleep(100);
    expect(old.inflight).toBe(0);
    const started = Date.now();
    expect((await openRepo(api, b)).status).toBe(200);
    await waitFor(async () => {
      try {
        old.ws.store.listReviews();
        return undefined;
      } catch {
        return true;
      }
    }, 5000);
    expect(Date.now() - started).toBeLessThan(5000);
    close();
    expect((await picking).body).toEqual({ status: 'cancelled' });
  });

  it('keeps the index and the overview when switching back, and does not recover interrupted records twice', async () => {
    const a = makeRepo();
    const b = makeRepo();
    const { server, api } = await start({ repo: a });
    await indexDone(api);
    const ov = await api<{ id: number }>('/api/overview', { method: 'POST', body: { noLlm: true, confirmed: true } });
    await waitFor(async () => ((await api<{ status: string }>(`/api/overview/jobs/${ov.body.id}`)).body.status === 'done' ? true : undefined));
    // 本进程 pid 的 running 审查：只在第一次打开数据目录时恢复，切回来时不能被改成 failed
    const stuck = server.app()!.ws.store.createReview({ working: true });
    expect((await openRepo(api, b)).status).toBe(200);
    await indexDone(api);
    const back = await openRepo(api, a);
    expect(back.body).toMatchObject({ repo: a, repoGen: 3 });
    const s = await indexDone(api);
    expect(s.index.job?.cached).toBe(true);
    expect(s.overview?.id).toBe(ov.body.id);
    expect(server.app()!.ws.store.getReview(stuck)?.status).toBe('running');
    server.app()!.ws.store.failReview(stuck, 'test cleanup');
  });

  it('rejects a second concurrent switch with 409 switch_in_progress', async () => {
    const a = makeRepo();
    const b = makeRepo();
    const c = makeRepo();
    let unblock: () => void = () => undefined;
    const blocked = new Promise<void>((r) => (unblock = r));
    const { api } = await start({
      repo: a,
      openWorkspace: async (repo, dataDir) => {
        await blocked;
        return testOpen(repo, dataDir);
      },
    });
    await indexDone(api);
    const first = openRepo(api, b);
    await sleep(100);
    const second = await openRepo(api, c);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('switch_in_progress');
    unblock();
    expect((await first).status).toBe(200);
  });

  it('rejects a repository that would share the data directory', async () => {
    const shared = tempDir('ci-switch-shared-');
    const a = makeRepo();
    const b = makeRepo();
    const { api } = await start({ workspace: await testOpen(a, shared), openWorkspace: (repo) => testOpen(repo, shared) });
    await indexDone(api);
    const r = await openRepo(api, b);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('data_dir_shared');
    const s = (await api<Status>('/api/status')).body;
    expect(s).toMatchObject({ repo: a, repoGen: 1 });
    // 当前仓库的 Store 仍可用
    expect((await api('/api/chat/sessions')).status).toBe(200);
  });

  it('uses the startup data directory only for the startup repository', async () => {
    const a = makeRepo();
    const b = makeRepo();
    const dataDir = tempDir('ci-switch-startup-data-');
    const { api } = await start({ workspace: await openWorkspace(a, dataDir, gated.resolver), openWorkspace: undefined, resolver: gated.resolver, indexOnStart: false });
    const toB = await openRepo(api, b);
    expect(toB.body.dataDir).toBe(path.join(b, '.codeinsight'));
    const toA = await openRepo(api, a);
    expect(toA.body.dataDir).toBe(dataDir);
    const repos = (await api<{ startupRepo: string; current: { dataDir: string } }>('/api/repos')).body;
    expect(repos).toMatchObject({ startupRepo: a, current: { dataDir } });
  });
});

describe('replaced repository contexts', () => {
  /** 请求体先发一半，请求停在读请求体这一步 */
  function partialPost(server: RunningHttpServer, p: string, head: string) {
    const req = httpRequest({
      host: '127.0.0.1', port: server.port, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.token}` },
    });
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
      req.on('response', (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
    });
    req.write(head);
    return { finish: (rest: string) => (req.end(rest), response) };
  }

  it('does not start a review in the old repository when the switch happens while the request body is being read', async () => {
    const a = makeRepo();
    const b = makeRepo();
    const { server, api } = await start({ repo: a });
    await indexDone(api);
    const old = server.app()!;
    const before = old.ws.store.listReviews().length;
    const pending = partialPost(server, '/api/reviews', '{"working":');
    await waitFor(async () => (old.inflight > 0 ? true : undefined));
    expect((await openRepo(api, b)).status).toBe(200);
    const r = await pending.finish('true, "noLlm": true}');
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body)).toMatchObject({ error: 'repo_changed', repoGen: 2 });
    expect(old.ws.store.listReviews().length).toBe(before);
    expect(old.reviewJobs.activeIds()).toEqual([]);
  });

  it('every task class refuses to start once the context is replaced, and no rebuild is triggered', async () => {
    const a = makeRepo();
    const b = makeRepo();
    const { server, api } = await start({ repo: a });
    await indexDone(api);
    const old = server.app()!;
    expect((await openRepo(api, b)).status).toBe(200);
    expect(old.closing).toBe(true);
    expect(() => old.indexJobs.start('api')).toThrow(RepoClosedError);
    expect(() => old.reviewJobs.start({ working: true })).toThrow(RepoClosedError);
    expect(() => old.askRuns.start(1, async () => undefined)).toThrow(RepoClosedError);
    await expect(old.overviewJobs.start({ contentKey: 'x' } as never, { noLlm: true, confirmed: true })).rejects.toThrow(RepoClosedError);
  });

  it('drops an overview whose estimate finished after the context was replaced', async () => {
    const a = makeRepo();
    const { server, api } = await start({ repo: a });
    await indexDone(api);
    const ctx = server.app()!;
    const snap = ctx.indexJobs.current()!;
    // 估算是异步的：开始检查已通过，估算期间上下文被替换
    const started = ctx.overviewJobs.start(snap, { noLlm: true });
    markClosing(ctx);
    await expect(started).rejects.toThrow(RepoClosedError);
    expect(ctx.overviewJobs.runningId).toBeUndefined();
    const latest = ctx.ws.store.overviews.list()[0];
    expect(latest?.status).toBe('failed');
  });

  it('closes the newly opened Store when the server shuts down during a switch', async () => {
    const a = makeRepo();
    const b = makeRepo();
    let unblock: () => void = () => undefined;
    const blocked = new Promise<void>((r) => (unblock = r));
    let opened: ServerWorkspace | undefined;
    const server = await startHttpServer({
      workspace: await testOpen(a), indexOnStart: false,
      openWorkspace: async (repo, dataDir) => {
        await blocked;
        return (opened = await testOpen(repo, dataDir));
      },
    });
    const api = apiFor(server);
    const switching = openRepo(api, b).catch(() => undefined);
    await sleep(100);
    const closed = server.close();
    unblock();
    await closed;
    await switching;
    await waitFor(async () => (opened ? true : undefined));
    await waitFor(async () => {
      try {
        opened!.store.listReviews();
        return undefined;
      } catch {
        return true;
      }
    });
    expect(server.app()).toBeUndefined();
  });
});

describe('locked repository', () => {
  it('reports repoLocked, rejects other repositories without probing them and allows the current one', async () => {
    const a = makeRepo();
    const b = makeRepo();
    const { api } = await start({ repo: a, lockRepo: true, indexOnStart: false });
    expect((await api<Status>('/api/status')).body.repoLocked).toBe(true);
    for (const p of [b, path.join(b, 'missing'), 'relative']) {
      const r = await openRepo(api, p);
      expect(r.status, p).toBe(409);
      expect(r.body.error).toBe('repo_locked');
    }
    const same = await openRepo(api, a);
    expect(same.status).toBe(200);
    expect(same.body.reused).toBe(true);
  });

  it('needs a startup repository', async () => {
    await expect(startHttpServer({ lockRepo: true })).rejects.toThrow(/lockRepo/);
  });
});

describe('repository header', () => {
  it('rejects requests for an older repository with 409 repo_changed and accepts the others', async () => {
    const a = makeRepo();
    const b = makeRepo();
    const { server, api } = await start({ repo: a, indexOnStart: false });
    expect((await openRepo(api, b)).status).toBe(200);
    const send = (gen?: string, p = '/api/chat/sessions') =>
      request(server.port, p, { headers: { Authorization: `Bearer ${server.token}`, ...(gen !== undefined ? { 'X-CodeInsight-Repo': gen } : {}) } });
    const stale = await send('1');
    expect(stale.status).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'repo_changed', repoGen: 2 });
    expect((await send('2')).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect((await send('1', '/api/status')).status).toBe(200);
    expect((await send('1', '/api/repos')).status).toBe(200);
  });

  it('reports repo_changed with a null gen when there is no repository', async () => {
    const { server } = await start();
    const r = await request(server.port, '/api/entries', { headers: { Authorization: `Bearer ${server.token}`, 'X-CodeInsight-Repo': '1' } });
    expect(r.status).toBe(409);
    expect(r.json()).toEqual({ error: 'repo_changed', message: 'the repository has changed', repoGen: null });
  });
});

describe('authentication of the repository APIs', () => {
  it('requires the token and an allowed Origin', async () => {
    const { server } = await start();
    for (const [p, method] of [['/api/repos', 'GET'], ['/api/repo', 'POST'], ['/api/repos/recent?path=/x', 'DELETE']] as const) {
      expect((await request(server.port, p, { method })).status, p).toBe(401);
      const bad = await request(server.port, p, { method, headers: { Authorization: `Bearer ${server.token}`, Origin: 'http://evil.example' } });
      expect(bad.status, p).toBe(403);
    }
  });
});

describe('starting on a port that is already in use', () => {
  it('fails without starting an index job and closes the Store', async () => {
    const a = makeRepo();
    const { server } = await start();
    const ws = await testOpen(a);
    let resolveCalls = 0;
    const resolver: Resolver = { name: 'counting', resolve: () => (resolveCalls++, Promise.reject(new Error('should not run'))) };
    await expect(startHttpServer({ workspace: { ...ws, resolver }, port: server.port, dirPicker: { tool: null } })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(() => ws.store.listReviews()).toThrow();
    await sleep(200);
    expect(resolveCalls).toBe(0);
  });
});
