import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, onRepoChanged } from '../api/client';
import type { StatusResponse } from '../api/types';
import { usePolling } from './usePolling';

/** 建索引期间的轮询间隔 */
export const BUSY_POLL_MS = 1500;
/** 其他时候的轮询间隔：别的标签页切换仓库、改设置后，这个页面在这个时间内跟上 */
export const IDLE_POLL_MS = 5000;

/** 还没读到状态（serve 刚启动）和建索引期间按短间隔 */
function pollInterval(s: StatusResponse | undefined): number {
  return !s || s.index.job?.status === 'running' ? BUSY_POLL_MS : IDLE_POLL_MS;
}

/** 页面是否可见；不可见时暂停轮询 */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

/**
 * /api/status：一直轮询（建索引期间 1.5 秒，其他时候 5 秒），页面不可见时暂停，回到可见时立即读一次。
 * 请求失败时显示错误并按间隔重试；refresh 和收到 409 repo_changed 时立即重新读。
 */
export function useStatus() {
  const [status, setStatus] = useState<StatusResponse>();
  const [error, setError] = useState<string>();
  const [round, setRound] = useState(0);
  const visible = usePageVisible();
  // 下一次的间隔按刚读到的状态决定，不用等下一次渲染
  const latest = useRef<StatusResponse>(undefined);
  usePolling<StatusResponse>(
    visible
      ? {
          load: () => api.status(),
          again: () => true,
          onData: (s) => {
            latest.current = s;
            setStatus(s);
            setError(undefined);
          },
          onError: (err) => setError(`读取服务状态失败：${errorMessage(err)}`),
          get intervalMs() {
            return pollInterval(latest.current);
          },
        }
      : undefined,
    [round, visible],
  );
  const refresh = useCallback(() => setRound((n) => n + 1), []);
  useEffect(() => onRepoChanged(refresh), [refresh]);
  const reindex = async () => {
    try {
      await api.startIndex();
      refresh();
    } catch (err) {
      setError(`发起建索引失败：${errorMessage(err)}`);
    }
  };
  return { status, error, refresh, reindex };
}
