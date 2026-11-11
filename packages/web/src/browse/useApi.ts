import { useContext, useEffect, useState } from 'react';
import { ApiError, errorMessage } from '../api/client';
import { NavContext } from '../app/nav';

/**
 * 按 deps 调用一个接口，返回数据和可见的错误信息；deps 变化或卸载后旧请求的结果丢弃。
 * 410 snapshot_gone 和 503 index_not_ready 交给页面级处理（重新取状态、显示建索引进度）；
 * 传入 onGone 时 410 改由它处理（用在没有 NavContext 的组件里）。
 */
export function useApi<T>(load: (() => Promise<T>) | undefined, deps: unknown[], onGone?: () => void) {
  const nav = useContext(NavContext);
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: load !== undefined });
  useEffect(() => {
    if (!load) return setState({ loading: false });
    let cancelled = false;
    setState((s) => ({ data: s.data, loading: true }));
    load().then(
      (data) => !cancelled && setState({ data, loading: false }),
      (err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.snapshotGone) (onGone ?? nav?.snapshotGone)?.();
        if (err instanceof ApiError && err.indexNotReady) nav?.indexNotReady();
        setState({ error: errorMessage(err), loading: false });
      },
    );
    return () => {
      cancelled = true;
    };
    // load 和回调每次渲染都是新函数，只在 deps 变化时重新请求
  }, deps);
  return state;
}
