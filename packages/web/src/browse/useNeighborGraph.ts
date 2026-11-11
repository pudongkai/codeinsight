import { useRef, useState } from 'react';
import { ApiError, api, errorMessage } from '../api/client';
import { initNeighbors, mergeTree, type NeighborState } from './neighbor-model';
import { useApi } from './useApi';

async function loadCenter(snapshotId: number, centerId: string): Promise<NeighborState> {
  const [callers, callees] = await Promise.all([api.callers(snapshotId, centerId, 1), api.callees(snapshotId, centerId, 1)]);
  return initNeighbors(snapshotId, callers, callees);
}

/** 加载中心函数的邻居图，节点可以逐层展开；快照已清理时调用 onGone */
export function useNeighborGraph(snapshotId: number, centerId: string, onGone: () => void) {
  const center = useApi(() => loadCenter(snapshotId, centerId), [snapshotId, centerId], onGone);
  // 展开后的图；只在它属于当前中心时使用，否则用刚加载的中心图
  const [expanded, setExpanded] = useState<NeighborState>();
  const [expandError, setExpandError] = useState<string>();
  // 正在展开的节点：同一个节点请求未返回时再点"展开"直接忽略
  const inflight = useRef(new Set<string>());
  const [loadingNode, setLoadingNode] = useState<string>();
  const isCurrent = (s: NeighborState | undefined) => s?.snapshotId === snapshotId && s.centerId === centerId;
  const state = isCurrent(expanded) ? expanded : isCurrent(center.data) ? center.data : undefined;

  const expand = async (nodeId: string) => {
    const node = state?.nodes[nodeId];
    if (!node || node.side === 'center' || node.expanded || inflight.current.has(nodeId)) return;
    const side = node.side;
    inflight.current.add(nodeId);
    setLoadingNode(nodeId);
    try {
      const tree = side === 'caller' ? await api.callers(snapshotId, nodeId, 1) : await api.callees(snapshotId, nodeId, 1);
      setExpanded((s) => {
        const base = isCurrent(s) ? s : center.data;
        return base && isCurrent(base) ? mergeTree(base, tree, side) : s;
      });
    } catch (err) {
      if (err instanceof ApiError && err.snapshotGone) onGone();
      setExpandError(errorMessage(err));
    } finally {
      inflight.current.delete(nodeId);
      setLoadingNode([...inflight.current].at(-1));
    }
  };

  const error = center.error ?? expandError;
  return {
    state,
    error: error === undefined ? undefined : `加载调用关系失败：${error}`,
    loading: center.loading ? 'center' : loadingNode,
    expand,
  };
}
