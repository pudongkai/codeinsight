import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../api/client';
import type { StatusResponse } from '../api/types';

const POLL_MS = 1500;

/** 是否需要继续轮询：索引正在建，或还没有可用的快照且上次没有失败 */
function needsPolling(s: StatusResponse | undefined): boolean {
  if (!s) return true;
  const job = s.index.job;
  return job?.status === 'running' || (!s.snapshot && job?.status !== 'failed');
}

/** /api/status：首次加载、建索引期间轮询，以及手动刷新 */
export function useStatus() {
  const [status, setStatus] = useState<StatusResponse>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  const refresh = useCallback(async () => {
    try {
      const s = await api.status();
      setStatus(s);
      setError(undefined);
      return s;
    } catch (err) {
      setError(`读取服务状态失败：${errorMessage(err)}`);
      return undefined;
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh, tick]);
  const polling = needsPolling(status) && !error;
  useEffect(() => {
    if (!polling) return;
    const t = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(t);
  }, [polling, refresh]);
  const reindex = async () => {
    try {
      await api.startIndex();
    } catch (err) {
      setError(`发起建索引失败：${errorMessage(err)}`);
    }
    setTick((n) => n + 1);
  };
  return { status, error, refresh, reindex };
}
