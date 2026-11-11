import { useEffect, useState } from 'react';
import { layoutGraph, type Positions } from './layout';
import type { GraphEdgeSpec, GraphNodeSpec } from './types';

/** 节点或边集合变化时重新布局；返回的 version 每次布局完成加一 */
export function useLayout(nodes: GraphNodeSpec[], edges: GraphEdgeSpec[]): { positions?: Positions; version: number; error?: string } {
  const [state, setState] = useState<{ positions?: Positions; version: number; error?: string }>({ version: 0 });
  const shape = nodes.map((n) => `${n.id}@${n.column ?? ''}`).join('|') + '#' + edges.map((e) => e.id).join('|');
  useEffect(() => {
    let cancelled = false;
    layoutGraph(nodes, edges).then(
      (positions) => !cancelled && setState((s) => ({ positions, version: s.version + 1 })),
      (err: Error) => !cancelled && setState((s) => ({ ...s, error: `布局失败：${err.message}` })),
    );
    return () => {
      cancelled = true;
    };
    // 只在图的形状变化时重新布局；节点上的回调变化不影响位置
  }, [shape]);
  return state;
}
