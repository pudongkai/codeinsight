import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api/client';
import type { ReviewResponse, StatusResponse } from '../src/api/types';
import { useStatus } from '../src/app/useStatus';
import { MAX_RETRY_MS, retryDelay } from '../src/app/usePolling';
import { useReviewJob } from '../src/review/useReviewJob';
import { makeReport } from './fixtures';

const down = () => new ApiError(0, 'network_error', 'network down');
const done = (id: number): ReviewResponse => ({ id, status: 'done', report: makeReport() }) as ReviewResponse;
const ready = { snapshot: { id: 1 }, index: { job: { status: 'done' } }, reviews: [] } as unknown as StatusResponse;

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
  it('retries when the first /api/status fails and stops once the snapshot is ready', async () => {
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
    await act(() => vi.advanceTimersByTimeAsync(6000));
    expect(status).toHaveBeenCalledTimes(3);
  });

  it('refresh() reads the status again after polling stopped', async () => {
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
