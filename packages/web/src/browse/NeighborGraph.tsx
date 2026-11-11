import { useMemo, useState } from 'react';
import { location } from '../format';
import { FlowGraph } from '../graph/FlowGraph';
import type { GraphEdgeSpec, GraphNodeSpec } from '../graph/types';
import { type NNode, type NeighborState, visibleNeighbors } from './neighbor-model';
import { OverflowList } from './OverflowList';

interface Props {
  state: NeighborState;
  showTests: boolean;
  loadingId?: string;
  onExpand(id: string): void;
  onCenter(node: NNode): void;
  onOpen(node: NNode): void;
}

function columnOf(n: NNode, maxCaller: number): number {
  if (n.side === 'caller') return maxCaller - n.level;
  return maxCaller + (n.side === 'callee' ? n.level : 0);
}

function nodeSpec(n: NNode, maxCaller: number, loadingId: string | undefined, onExpand: (id: string) => void): GraphNodeSpec {
  const canExpand = n.side !== 'center' && !n.expanded;
  return {
    id: n.info.id, label: n.info.name, sublabel: location(n.info.path, n.info.startLine), title: n.info.qualifiedName,
    tone: n.side === 'center' ? 'center' : n.info.isTest ? 'test' : 'neighbor',
    badge: loadingId === n.info.id ? '加载中' : n.info.isTest ? '测试' : undefined,
    column: columnOf(n, maxCaller),
    attrs: { side: n.side, level: String(n.level), name: n.info.name, qname: n.info.qualifiedName },
    onExpand: canExpand ? () => onExpand(n.info.id) : undefined,
  };
}

/** 中心函数左边是调用方，右边是被调用方；超过上限的折叠成"还有 N 个"节点 */
export function NeighborGraph({ state, showTests, loadingId, onExpand, onCenter, onOpen }: Props) {
  const [overflowSide, setOverflowSide] = useState<'caller' | 'callee'>();
  const view = useMemo(() => visibleNeighbors(state, showTests), [state, showTests]);
  const { nodes, edges } = useMemo(() => {
    const maxCaller = Math.max(0, ...view.nodes.filter((n) => n.side === 'caller').map((n) => n.level));
    const specs = view.nodes.map((n) => nodeSpec(n, maxCaller, loadingId, onExpand));
    const es: GraphEdgeSpec[] = view.edges.map((e) => ({ id: `${e.src}->${e.dst}`, source: e.src, target: e.dst, tone: 'normal' }));
    for (const side of ['caller', 'callee'] as const) {
      const hidden = view.overflow[side];
      if (hidden.length === 0) continue;
      const id = `overflow:${side}`;
      specs.push({ id, label: `还有 ${hidden.length} 个`, sublabel: '点击按文件列出', tone: 'overflow', column: side === 'caller' ? 0 : maxCaller + 1, attrs: { side: 'overflow' } });
      es.push(side === 'caller' ? { id, source: id, target: state.centerId, tone: 'normal' } : { id, source: state.centerId, target: id, tone: 'normal' });
    }
    return { nodes: specs, edges: es };
  }, [view, loadingId, onExpand, state.centerId]);
  const pick = (id: string) => state.nodes[id];
  const click = (id: string) => {
    if (id.startsWith('overflow:')) return setOverflowSide(id.slice('overflow:'.length) as 'caller' | 'callee');
    const n = pick(id);
    if (n && n.side !== 'center') onCenter(n);
  };
  const dbl = (id: string) => {
    const n = pick(id);
    if (n) onOpen(n);
  };
  return (
    <>
      <FlowGraph nodes={nodes} edges={edges} onNodeClick={click} onNodeDoubleClick={dbl} height={520} testId="neighbor-graph" />
      {overflowSide && <OverflowList side={overflowSide} nodes={view.overflow[overflowSide]} onPick={onCenter} onClose={() => setOverflowSide(undefined)} />}
    </>
  );
}
