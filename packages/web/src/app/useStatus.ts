import { useCallback, useState } from 'react';
import { api, errorMessage } from '../api/client';
import type { StatusResponse } from '../api/types';
import { usePolling } from './usePolling';

const POLL_MS = 1500;

/** 是否需要继续轮询：索引正在建，或还没有可用的快照且上次没有失败 */
function needsPolling(s: StatusResponse): boolean {
  const job = s.index.job;
  return job?.status === 'running' || (!s.snapshot && job?.status !== 'failed');
}

/**
 * /api/status：首次加载、建索引期间轮询，以及手动刷新。
 * 请求失败时显示错误并按间隔重试；refresh 重新开始一轮，状态变成需要轮询时会继续轮询。
 */
export function useStatus() {
  const [status, setStatus] = useState<StatusResponse>();
  const [error, setError] = useState<string>();
  const [round, setRound] = useState(0);
  usePolling<StatusResponse>(
    {
      load: () => api.status(),
      again: needsPolling,
      onData: (s) => {
        setStatus(s);
        setError(undefined);
      },
      onError: (err) => setError(`读取服务状态失败：${errorMessage(err)}`),
      intervalMs: POLL_MS,
    },
    [round],
  );
  const refresh = useCallback(() => setRound((n) => n + 1), []);
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
