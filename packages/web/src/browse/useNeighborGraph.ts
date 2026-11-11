import { useEffect, useState } from 'react';
import { ApiError, api, errorMessage } from '../api/client';
import { initNeighbors, mergeTree, type NeighborState } from './neighbor-model';

/** 加载中心函数的邻居图，节点可以逐层展开；快照已清理时调用 onGone */
export function useNeighborGraph(snapshotId: number, centerId: string, onGone: () => void) {
  const [state, setState] = useState<NeighborState>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState<string | undefined>('center');

  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.snapshotGone) onGone();
    setError(`加载调用关系失败：${errorMessage(err)}`);
  };

  useEffect(() => {
    let cancelled = false;
    setState(undefined);
    setError(undefined);
    setLoading('center');
    Promise.all([api.callers(snapshotId, centerId, 1), api.callees(snapshotId, centerId, 1)]).then(
      ([callers, callees]) => !cancelled && setState(initNeighbors(snapshotId, callers, callees)),
      (err: unknown) => !cancelled && fail(err),
    ).finally(() => !cancelled && setLoading(undefined));
    return () => {
      cancelled = true;
    };
    // fail 只读 onGone，目标变化时才重新加载
  }, [snapshotId, centerId]);

  const expand = async (nodeId: string) => {
    const node = state?.nodes[nodeId];
    if (!node || node.side === 'center' || node.expanded) return;
    setLoading(nodeId);
    try {
      const tree = node.side === 'caller' ? await api.callers(snapshotId, nodeId, 1) : await api.callees(snapshotId, nodeId, 1);
      setState((s) => (s && s.centerId === centerId ? mergeTree(s, tree, node.side as 'caller' | 'callee') : s));
    } catch (err) {
      fail(err);
    } finally {
      setLoading(undefined);
    }
  };

  return { state, error, loading, expand };
}
