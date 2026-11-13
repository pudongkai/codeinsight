import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api/client';
import type { ReviewResponse, StatusResponse } from '../src/api/types';
import { BUSY_POLL_MS, IDLE_POLL_MS, useStatus } from '../src/app/useStatus';
import { MAX_RETRY_MS, retryDelay } from '../src/app/usePolling';
import { useReviewJob } from '../src/review/useReviewJob';
import { makeReport } from './fixtures';

const down = () => new ApiError(0, 'network_error', 'network down');
const done = (id: number): ReviewResponse => ({ id, status: 'done', report: makeReport() }) as ReviewResponse;
const ready = { snapshot: { id: 1 }, index: { job: { status: 'done' } }, reviews: [] } as unknown as StatusResponse;
const indexing = { snapshot: null, index: { job: { status: 'running' } }, reviews: [] } as unknown as StatusResponse;

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

afterEach(() => {
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const flush = () => act(() => vi.advanceTimersByTimeAsync(0));

describe('useReviewJob', () => {
  it('keeps polling after a failed read, shows the error, then clears it', async () => {
    const review = vi.spyOn(api, 'review').mockRejectedValueOnce(down()).mockResolvedValue(done(3));
    const onFinished = vi.fn();
    const { result } = renderHook(() => useReviewJob(onFinished));
    act(() => result.current.open(3));
    await flush();
    expect(result.current.error).toContain('读取审查结果失败');
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(review).toHaveBeenCalledTimes(2);
    expect(result.current.job?.status).toBe('done');
    expect(result.current.error).toBeUndefined();
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it('opening the current review again reloads it instead of leaving it blank', async () => {
    const review = vi.spyOn(api, 'review').mockResolvedValue(done(5));
    const { result } = renderHook(() => useReviewJob(() => undefined));
    act(() => result.current.open(5));
    await flush();
    act(() => result.current.open(5));
    await flush();
    expect(review).toHaveBeenCalledTimes(2);
    expect(result.current.job?.id).toBe(5);
  });
});

describe('useStatus', () => {
  it('retries when the first /api/status fails, then keeps polling every 5 seconds once the snapshot is ready', async () => {
    const status = vi.spyOn(api, 'status').mockRejectedValueOnce(down()).mockRejectedValueOnce(down()).mockResolvedValue(ready);
    const { result } = renderHook(() => useStatus());
    await flush();
    expect(result.current.error).toContain('读取服务状态失败');
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(result.current.error).toContain('读取服务状态失败');
    // 第二次连续失败后间隔翻倍
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(status).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(result.current.status).toBe(ready);
    expect(result.current.error).toBeUndefined();
    await act(() => vi.advanceTimersByTimeAsync(IDLE_POLL_MS - 1));
    expect(status).toHaveBeenCalledTimes(3);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(status).toHaveBeenCalledTimes(4);
  });

  it('polls every 1.5 seconds while the index is being built', async () => {
    const status = vi.spyOn(api, 'status').mockResolvedValue(indexing);
    renderHook(() => useStatus());
    await flush();
    await act(() => vi.advanceTimersByTimeAsync(BUSY_POLL_MS * 2));
    expect(status).toHaveBeenCalledTimes(3);
  });

  it('pauses while the page is hidden and reads once right away when it becomes visible again', async () => {
    const status = vi.spyOn(api, 'status').mockResolvedValue(ready);
    renderHook(() => useStatus());
    await flush();
    setHidden(true);
    await act(() => vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 4));
    expect(status).toHaveBeenCalledTimes(1);
    setHidden(false);
    await flush();
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('reads the status again right away when a request gets 409 repo_changed', async () => {
    const status = vi.spyOn(api, 'status').mockResolvedValue(ready);
    renderHook(() => useStatus());
    await flush();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'repo_changed', repoGen: 2 }), { status: 409 }));
    await act(() => api.entries().catch(() => undefined));
    await flush();
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('refresh() reads the status again', async () => {
    const status = vi.spyOn(api, 'status').mockResolvedValue(ready);
    const { result } = renderHook(() => useStatus());
    await flush();
    act(() => result.current.refresh());
    await flush();
    expect(status).toHaveBeenCalledTimes(2);
  });
});

describe('usePolling retries', () => {
  it('stops retrying after 401 or 404 and keeps the error on screen', async () => {
    for (const err of [new ApiError(401, 'unauthorized', 'unauthorized'), new ApiError(404, 'not_found', 'not_found: review 9')]) {
      const review = vi.spyOn(api, 'review').mockRejectedValue(err);
      const { result, unmount } = renderHook(() => useReviewJob(() => undefined));
      act(() => result.current.open(9));
      await flush();
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(review).toHaveBeenCalledTimes(1);
      expect(result.current.error).toContain(err.code);
      unmount();
      review.mockRestore();
    }
  });

  it('lengthens the interval on repeated failures up to the cap', async () => {
    const review = vi.spyOn(api, 'review').mockRejectedValue(down());
    const { result } = renderHook(() => useReviewJob(() => undefined));
    act(() => result.current.open(4));
    await flush();
    const times = [0];
    for (const wait of [1000, 2000, 4000, 8000, MAX_RETRY_MS, MAX_RETRY_MS]) {
      await act(() => vi.advanceTimersByTimeAsync(wait - 1));
      expect(review).toHaveBeenCalledTimes(times.length);
      await act(() => vi.advanceTimersByTimeAsync(1));
      times.push(wait);
      expect(review).toHaveBeenCalledTimes(times.length);
    }
    expect(retryDelay(1000, 1)).toBe(1000);
    expect(retryDelay(1500, 20)).toBe(MAX_RETRY_MS);
  });
});
