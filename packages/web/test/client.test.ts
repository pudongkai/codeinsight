import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, onRepoChanged, resetRepoGen } from '../src/api/client';
import { makeStatus } from './fixtures';

afterEach(() => resetRepoGen());

function mockFetch(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

describe('api client', () => {
  it('relies on the same-origin cookie and never sends a token header', async () => {
    const f = mockFetch(200, { id: 3 });
    await api.createReview({ working: true });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('/api/reviews');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{"working":true}' });
    expect(JSON.stringify(init?.headers ?? {})).not.toMatch(/authorization/i);
  });

  it('maps 410 snapshot_gone and 503 index_not_ready to typed errors', async () => {
    mockFetch(410, { error: 'snapshot_gone' });
    const gone = await api.callers(1, 'x').catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(ApiError);
    expect((gone as ApiError).snapshotGone).toBe(true);
    vi.restoreAllMocks();
    mockFetch(503, { error: 'index_not_ready', message: 'the working tree index is being built' });
    const notReady = (await api.search('f').catch((e: unknown) => e)) as ApiError;
    expect(notReady.indexNotReady).toBe(true);
    expect(notReady.message).toContain('being built');
  });

  it('turns network failures into a visible error message', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(api.status()).rejects.toMatchObject({ code: 'network_error', message: expect.stringContaining('Failed to fetch') });
  });

  it('encodes symbol ids and query parameters', async () => {
    const f = mockFetch(200, {});
    await api.source(4, 'a b/c.py', 1, 9);
    expect(f.mock.calls[0]![0]).toBe('/api/source?snapshot=4&path=a+b%2Fc.py&start=1&end=9');
  });

  it('after reading the status, every request carries the repo generation header', async () => {
    const f = mockFetch(200, {});
    await api.entries();
    expect(JSON.stringify(f.mock.calls[0]![1]?.headers ?? {})).not.toContain('X-CodeInsight-Repo');
    f.mockResolvedValueOnce(new Response(JSON.stringify(makeStatus({ repoGen: 3 })), { status: 200 }));
    await api.status();
    await api.createReview({ working: true });
    expect(f.mock.calls[2]![1]?.headers).toMatchObject({ 'X-CodeInsight-Repo': '3', 'Content-Type': 'application/json' });
    f.mockResolvedValueOnce(new Response(JSON.stringify(makeStatus({ repo: null, repoGen: null })), { status: 200 }));
    await api.status();
    await api.entries();
    expect(f.mock.calls[4]![1]?.headers).toMatchObject({ 'X-CodeInsight-Repo': 'null' });
  });

  it('409 repo_changed notifies the listeners; other errors do not', async () => {
    const listener = vi.fn();
    const off = onRepoChanged(listener);
    mockFetch(409, { error: 'repo_busy', tasks: [] });
    await api.openRepo('/x').catch(() => undefined);
    expect(listener).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    mockFetch(409, { error: 'repo_changed', repoGen: 4 });
    const err = (await api.entries().catch((e: unknown) => e)) as ApiError;
    expect(err.repoChanged).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });
});
