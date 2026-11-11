import { useEffect, useRef } from 'react';
import { ApiError } from '../api/client';

export interface PollOptions<T> {
  load(): Promise<T>;
  /** 拿到结果后是否还要继续取 */
  again(data: T): boolean;
  onData(data: T): void;
  /** 出错时通知；401、404 之后停止，其他错误按逐步拉长的间隔重试 */
  onError(err: unknown): void;
  intervalMs: number;
}

/** 连续失败时重试间隔的上限 */
export const MAX_RETRY_MS = 10_000;

/** 第 failures 次连续失败后的重试间隔：从 intervalMs 起每次翻倍，不超过 MAX_RETRY_MS */
export function retryDelay(intervalMs: number, failures: number): number {
  return Math.min(intervalMs * 2 ** Math.max(0, failures - 1), Math.max(intervalMs, MAX_RETRY_MS));
}

function isPermanent(err: unknown): boolean {
  return err instanceof ApiError && err.permanent;
}

/**
 * 立即取一次，之后按间隔反复取，直到 again 返回 false。
 * 上一次请求结束后才安排下一次，不会并发；opts 为 undefined、deps 变化或卸载时停止，已发出的请求结果丢弃。
 * 请求失败时：401、404 重试也不会成功，直接停止；其他错误连续失败时间隔逐步拉长，成功一次后恢复原间隔。
 */
export function usePolling<T>(opts: PollOptions<T> | undefined, deps: unknown[]) {
  // 回调每次渲染都是新函数，用 ref 读最新的，只在 deps 变化时重新开始
  const latest = useRef(opts);
  latest.current = opts;
  const enabled = opts !== undefined;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: number | undefined;
    let failures = 0;
    const next = (delayMs: number) => {
      if (!cancelled) timer = window.setTimeout(() => void poll(), delayMs);
    };
    const poll = async () => {
      const o = latest.current;
      if (!o) return;
      try {
        const data = await o.load();
        if (cancelled) return;
        failures = 0;
        o.onData(data);
        if (o.again(data)) next(o.intervalMs);
      } catch (err) {
        if (cancelled) return;
        o.onError(err);
        if (!isPermanent(err)) next(retryDelay(o.intervalMs, ++failures));
      }
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled, ...deps]);
}
