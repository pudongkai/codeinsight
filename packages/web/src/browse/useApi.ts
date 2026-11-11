import { useEffect, useState } from 'react';
import { ApiError, errorMessage } from '../api/client';
import { useNav } from '../app/nav';

/**
 * 按 deps 调用一个接口，返回数据和可见的错误信息。
 * 410 snapshot_gone 和 503 index_not_ready 交给页面级处理（重新取状态、显示建索引进度）。
 */
export function useApi<T>(load: (() => Promise<T>) | undefined, deps: unknown[]) {
  const nav = useNav();
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: false });
  useEffect(() => {
    if (!load) return setState({ loading: false });
    let cancelled = false;
    setState((s) => ({ data: s.data, loading: true }));
    load().then(
      (data) => !cancelled && setState({ data, loading: false }),
      (err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.snapshotGone) nav.snapshotGone();
        if (err instanceof ApiError && err.indexNotReady) nav.indexNotReady();
        setState({ error: errorMessage(err), loading: false });
      },
    );
    return () => {
      cancelled = true;
    };
  }, deps);
  return state;
}
