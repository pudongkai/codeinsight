import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EdgeRow } from '@codeinsight/core';
import { startHttpServer, type RunningHttpServer, type ServerWorkspace } from '../src/index.js';
import { fixtureRepo, openWorkspace, request, tempDir, waitFor } from './helpers/env.js';

interface SymbolInfo { id: string; key: string; name: string; qualifiedName: string; path: string; isTest: boolean; depth?: number }
interface Status { index: { job: { id: number; status: string; snapshotId?: number } | null }; snapshot: { id: number } | null; reviews: { id: number }[] }
interface Tree { nodes: (SymbolInfo & { depth: number })[]; edges: { srcId: string; dstId: string; kind: string; line: number }[] }

let repo: string;
let dataDir: string;
let ws: ServerWorkspace;
let server: RunningHttpServer;

const prevLevel = process.env.CODEINSIGHT_LOG;

async function api<T = Record<string, unknown>>(rawPath: string, opts: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const res = await request(server.port, rawPath, { ...opts, headers: { Authorization: `Bearer ${server.token}` } });
  return { status: res.status, body: res.body ? res.json<T>() : ({} as T) };
}

async function indexDone(jobId?: number): Promise<Status> {
  return waitFor(async () => {
    const s = (await api<Status>('/api/status')).body;
    const job = s.index.job;
    if (job?.status === 'failed') throw new Error('index job failed');
    return job?.status === 'done' && (jobId === undefined || job.id === jobId) ? s : undefined;
  });
}

async function searchOne(name: string): Promise<SymbolInfo> {
  const { body } = await api<{ results: SymbolInfo[] }>(`/api/symbols/search?q=${name}`);
  const hit = body.results.find((r) => r.name === name);
  if (!hit) throw new Error(`symbol ${name} not found`);
  return hit;
}

beforeAll(async () => {
  process.env.CODEINSIGHT_LOG = 'silent';
  repo = fixtureRepo();
  // 未跟踪的符号链接，指向仓库外的文件
  const outside = tempDir('ci-outside-');
  writeFileSync(path.join(outside, 'secret.py'), 'SECRET = "top-secret"\n');
  symlinkSync(path.join(outside, 'secret.py'), path.join(repo, 'pkg', 'leak.py'));
  dataDir = tempDir('ci-server-data-');
  ws = await openWorkspace(repo, dataDir);
  server = await startHttpServer({ workspace: ws, staticDir: path.join(dataDir, 'no-web'), keepAliveMs: 100 });
});

afterAll(async () => {
  await server?.close();
  ws?.store.close();
  if (prevLevel === undefined) delete process.env.CODEINSIGHT_LOG;
  else process.env.CODEINSIGHT_LOG = prevLevel;
});

describe('index jobs', () => {
  it('builds the working tree index in the background on start', async () => {
    const s = await indexDone();
    expect(s.snapshot?.id).toBe(s.index.job?.snapshotId);
  });

  it('POST /api/index goes from running to done', async () => {
    const { status, body } = await api<{ id: number; status: string }>('/api/index', { method: 'POST' });
    expect(status).toBe(202);
    expect(body.status).toBe('running');
    const s = await indexDone(body.id);
    expect(s.index.job?.id).toBe(body.id);
  });
});

describe('symbol search and graph', () => {
  it('orders exact > prefix > substring, production code before test code', async () => {
    const { status, body } = await api<{ results: SymbolInfo[] }>('/api/symbols/search?q=find');
    expect(status).toBe(200);
    expect(body.results.map((r) => `${r.name}${r.isTest ? ' (test)' : ''}`)).toEqual([
      'find', 'find_all', 'find_helper (test)', 'refind', 'test_find (test)',
    ]);
    const limited = await api<{ results: SymbolInfo[] }>('/api/symbols/search?q=find&limit=2&kind=function');
    expect(limited.body.results.map((r) => r.name)).toEqual(['find', 'find_all']);
  });

  it('callers / callees match the edges table', async () => {
    const snapId = (await indexDone()).snapshot!.id;
    const edges = ws.store.getEdges(snapId).filter((e) => (e.kind === 'call' || e.kind === 'reference') && e.srcId !== e.dstId);
    const check = async (name: string, direction: 'callers' | 'callees') => {
      const sym = await searchOne(name);
      const { status, body } = await api<Tree>(`/api/symbols/${snapId}/${sym.id}/${direction}?depth=1`);
      expect(status).toBe(200);
      const expected = edges.filter((e: EdgeRow) => (direction === 'callers' ? e.dstId : e.srcId) === sym.id);
      const far = (e: { srcId: string; dstId: string }) => (direction === 'callers' ? e.srcId : e.dstId);
      expect(new Set(body.nodes.map((n) => n.id))).toEqual(new Set(expected.map(far)));
      expect(body.edges.map((e) => `${e.srcId}>${e.dstId}:${e.kind}:${e.line}`).sort()).toEqual(expected.map((e) => `${e.srcId}>${e.dstId}:${e.kind}:${e.line}`).sort());
      expect(body.nodes.length).toBeGreaterThan(0);
      return body;
    };
    const callers = await check('f', 'callers');
    expect(callers.nodes.map((n) => n.qualifiedName)).toEqual(expect.arrayContaining(['g', 'use', 'test_f']));
    await check('use', 'callees');
    const deeper = await api<Tree>(`/api/symbols/${snapId}/${(await searchOne('f')).id}/callers?depth=2`);
    expect(deeper.body.nodes.some((n) => n.depth === 2)).toBe(true);
    const noTests = await api<Tree>(`/api/symbols/${snapId}/${(await searchOne('f')).id}/callers?tests=false`);
    expect(noTests.body.nodes.some((n) => n.isTest)).toBe(false);
  });

  it('returns symbol details with entry info and neighbor counts', async () => {
    const snapId = (await indexDone()).snapshot!.id;
    const sym = await searchOne('get_item');
    const { status, body } = await api<{ symbol: { docstring: string | null }; entries: { framework: string }[]; callers: { total: number } }>(`/api/symbols/${snapId}/${sym.id}`);
    expect(status).toBe(200);
    expect(body.entries[0]?.framework).toBe('fastapi');
    const f = await api<{ symbol: { docstring: string }; callers: { prod: number; test: number } }>(`/api/symbols/${snapId}/${(await searchOne('f')).id}`);
    expect(f.body.symbol.docstring).toContain('Join a path');
    expect(f.body.callers.test).toBeGreaterThan(0);
    expect((await api(`/api/symbols/${snapId}/nope`)).status).toBe(404);
  });

  it('lists entries filtered by kind and framework', async () => {
    const all = await api<{ entries: { kind: string; framework: string; symbol: SymbolInfo }[] }>('/api/entries');
    expect(new Set(all.body.entries.map((e) => e.framework))).toEqual(new Set(['fastapi', 'flask', 'django', 'celery', 'click']));
    const flask = await api<{ entries: { symbol: SymbolInfo }[] }>('/api/entries?kind=http&framework=flask');
    expect(flask.body.entries.map((e) => e.symbol.name)).toEqual(['hello', 'plain']);
  });

  it('returns similar candidates for one function', async () => {
    const snapId = (await indexDone()).snapshot!.id;
    const reg = (await api<{ results: SymbolInfo[] }>('/api/symbols/search?q=register')).body.results.find((r) => r.path === 'pkg/extra.py')!;
    const { status, body } = await api<{ candidates: { symbol: SymbolInfo; reasons: string[] }[] }>(`/api/similar?snapshot=${snapId}&id=${reg.id}`);
    expect(status).toBe(200);
    expect(body.candidates.map((c) => c.symbol.path)).toContain('pkg/service.py');
  });
});

describe('source', () => {
  it('returns a line range of a file in the snapshot', async () => {
    const snapId = (await indexDone()).snapshot!.id;
    const { status, body } = await api<{ content: string; totalLines: number }>(`/api/source?snapshot=${snapId}&path=pkg/repo.py&start=4&end=6`);
    expect(status).toBe(200);
    expect(body.content).toBe('def f(x):\n    """Join a path."""\n    return os.path.join("a", str(x))');
  });

  it('rejects paths outside the repository', async () => {
    const snapId = (await indexDone()).snapshot!.id;
    const bad = [
      '../outside.py', 'pkg/../../outside.py', '/etc/passwd', '..%2f..%2fetc%2fpasswd', '%2e%2e%2fsecret.py', 'pkg%2f..%2f..%2fx.py', 'pkg\\..\\..\\x.py',
    ];
    for (const p of bad) {
      const res = await api<{ error: string }>(`/api/source?snapshot=${snapId}&path=${p}`);
      expect(res.status, p).toBe(403);
      expect(res.body.error).toBe('path_outside_repo');
    }
    // 符号链接在文件清单里，但实际指向仓库外
    expect(ws.store.getFile(snapId, 'pkg/leak.py')).toBeDefined();
    const leak = await request(server.port, `/api/source?snapshot=${snapId}&path=pkg/leak.py`, { headers: { Authorization: `Bearer ${server.token}` } });
    expect(leak.status).toBe(403);
    expect(leak.body).not.toContain('top-secret');
    // 数据目录和清单外的文件不能读
    expect((await api(`/api/source?snapshot=${snapId}&path=.git/config`)).status).toBe(404);
  });

  it('does not leak the link target through the snapshot copy after the link is removed from the working tree', async () => {
    const snapId = (await indexDone()).snapshot!.id;
    rmSync(path.join(repo, 'pkg', 'leak.py'));
    const res = await request(server.port, `/api/source?snapshot=${snapId}&path=pkg/leak.py`, { headers: { Authorization: `Bearer ${server.token}` } });
    expect([403, 404]).toContain(res.status);
    expect(res.body).not.toContain('top-secret');
  });
});

describe('current snapshot', () => {
  it('keeps the current snapshot marked as recently used', async () => {
    const snapId = (await indexDone()).snapshot!.id;
    ws.store.touchSnapshot(snapId, 1);
    await waitFor(async () => (ws.store.getSnapshot(snapId)!.lastUsedAt > 1 ? true : undefined), 5000);
  });

  it('rebuilds automatically when the current snapshot has been cleaned up', async () => {
    const old = (await indexDone()).snapshot!.id;
    ws.store.deleteSnapshot(old);
    const s = (await api<Status & { index: { job: { reason: string } } }>('/api/status')).body;
    expect(s.snapshot).toBeNull();
    expect(s.index.job).toMatchObject({ reason: 'snapshot_gone', status: 'running' });
    const search = await waitFor(async () => {
      const r = await api<{ snapshotId: number; results: SymbolInfo[] }>('/api/symbols/search?q=find');
      if (r.status !== 200) {
        expect(r.status).toBe(503);
        return undefined;
      }
      return r.body;
    });
    expect(search.snapshotId).not.toBe(old);
    expect(search.results[0]?.name).toBe('find');
    expect((await api<Status>('/api/status')).body.snapshot?.id).toBe(search.snapshotId);
  });
});

describe('review jobs and snapshot lifecycle', () => {
  let reviewId: number;
  let baseSnapshot: number;

  it('POST /api/reviews goes from running to done', async () => {
    const { status, body } = await api<{ id: number }>('/api/reviews', { method: 'POST', body: { head: 'HEAD' } });
    expect(status).toBe(202);
    reviewId = body.id;
    expect((await api<{ status: string }>(`/api/reviews/${reviewId}`)).body.status).toBe('running');
    const done = await waitFor(async () => {
      const r = (await api<{ status: string; error?: string; report?: { base: { snapshotId: number }; modules: { symbols: { name: string; change: string }[] }[] } }>(`/api/reviews/${reviewId}`)).body;
      if (r.status === 'failed') throw new Error(r.error);
      return r.status === 'done' ? r : undefined;
    });
    const changes = done.report!.modules.flatMap((m) => m.symbols.map((s) => `${s.change} ${s.name}`));
    expect(changes).toContain('added h');
    baseSnapshot = done.report!.base.snapshotId;
    expect((await api<Status>('/api/status')).body.reviews.map((r) => r.id)).toContain(reviewId);
  });

  it('rejects invalid review params', async () => {
    expect((await api('/api/reviews', { method: 'POST', body: { head: 'HEAD', working: true } })).status).toBe(400);
    expect((await api('/api/reviews', { method: 'POST', body: { working: 'yes' } })).status).toBe(400);
    expect((await api('/api/reviews/999999')).status).toBe(404);
  });

  it('returns 410 for a cleaned-up snapshot', async () => {
    const sym = ws.store.getSymbols(baseSnapshot).find((s) => s.name === 'f')!;
    expect((await api(`/api/symbols/${baseSnapshot}/${sym.id}`)).status).toBe(200);
    ws.store.deleteSnapshot(baseSnapshot);
    for (const p of [`/api/symbols/${baseSnapshot}/${sym.id}`, `/api/symbols/${baseSnapshot}/${sym.id}/callers`, `/api/source?snapshot=${baseSnapshot}&path=pkg/repo.py`, `/api/similar?snapshot=${baseSnapshot}&id=${sym.id}`, '/api/symbols/987654/x']) {
      const res = await api<{ error: string }>(p);
      expect(res.status, p).toBe(410);
      expect(res.body.error).toBe('snapshot_gone');
    }
  });

  it('still returns the report after a restart', async () => {
    await server.close();
    ws.store.close();
    ws = await openWorkspace(repo, dataDir);
    server = await startHttpServer({ workspace: ws, indexOnStart: false });
    const { status, body } = await api<{ status: string; report?: { schemaVersion: number } }>(`/api/reviews/${reviewId}`);
    expect(status).toBe(200);
    expect(body.status).toBe('done');
    expect(body.report?.schemaVersion).toBe(1);
    // 还没建好索引时搜索不可用
    expect((await api('/api/symbols/search?q=f')).status).toBe(503);
  });
});
