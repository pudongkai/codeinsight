import { useMemo, useState } from 'react';
import { location } from '../format';
import { FlowGraph } from '../graph/FlowGraph';
import { Pager } from '../graph/Pager';
import type { GraphEdgeSpec, GraphNodeSpec } from '../graph/types';
import { symbolMarks } from '../marks/marks';
import { groupKey, type NNode, type NeighborSide, type NeighborState, type PageGroup, visibleNeighbors } from './neighbor-model';

interface Props {
  state: NeighborState;
  showTests: boolean;
  showModels: boolean;
  loadingId?: string;
  onExpand(id: string): void;
  onCenter(node: NNode): void;
  onOpen(node: NNode): void;
}

type SetPage = (key: string, page: number) => void;

function columnOf(n: NNode, maxCaller: number): number {
  if (n.side === 'caller') return maxCaller - n.level;
  return maxCaller + (n.side === 'callee' ? n.level : 0);
}

/** 展开过的邻居节点：下一层超过一页时在节点里翻页 */
function nodePager(n: NNode, groups: Record<string, PageGroup>, setPage: SetPage): GraphNodeSpec['pager'] {
  if (n.side === 'center') return undefined;
  const g = groups[groupKey(n.side, n.info.id)];
  return g && g.pages > 1 ? { page: g.page, pages: g.pages, total: g.total, onPage: (p) => setPage(g.key, p) } : undefined;
}

function nodeSpec(n: NNode, maxCaller: number, props: Props, groups: Record<string, PageGroup>, setPage: SetPage): GraphNodeSpec {
  const canExpand = n.side !== 'center' && !n.expanded;
  return {
    id: n.info.id, label: n.info.name, sublabel: location(n.info.path, n.info.startLine), title: n.info.qualifiedName,
    tone: n.side === 'center' ? 'center' : n.info.isTest ? 'test' : 'neighbor',
    badge: props.loadingId === n.info.id ? '加载中' : n.info.isTest ? '测试' : undefined,
    column: columnOf(n, maxCaller),
    attrs: { side: n.side, level: String(n.level), name: n.info.name, qname: n.info.qualifiedName },
    marks: symbolMarks(n.info),
    onExpand: canExpand ? () => props.onExpand(n.info.id) : undefined,
    pager: nodePager(n, groups, setPage),
  };
}

const SIDE_LABELS: Record<NeighborSide, string> = { caller: '上游（调用方）', callee: '下游（被调用方）' };

/** 中心函数两侧的翻页控件：左边上游，右边下游 */
function CenterPagers({ state, groups, setPage }: { state: NeighborState; groups: Record<string, PageGroup>; setPage: SetPage }) {
  const pager = (side: NeighborSide) => {
    const g = groups[groupKey(side, state.centerId)];
    return g ? <Pager label={SIDE_LABELS[side]} page={g.page} pages={g.pages} total={g.total} hiddenModels={g.hiddenModels} onPage={(p) => setPage(g.key, p)} testId={`pager-${side}`} /> : <span />;
  };
  return (
    <div className="graph-pagers">
      {pager('caller')}
      {pager('callee')}
    </div>
  );
}

/**
 * 中心函数左边是调用方，右边是被调用方。每个节点在它那一侧的下一层每页显示 5 个：
 * 中心的两侧在图上方翻页，展开过的节点在节点里翻页。换中心时整个视图重新挂载，页码回到第 1 页。
 */
export function NeighborGraph(props: Props) {
  const { state, showTests, showModels, onCenter, onOpen } = props;
  const [pages, setPages] = useState<Record<string, number>>({});
  const view = useMemo(() => visibleNeighbors(state, { showTests, showModels, pages }), [state, showTests, showModels, pages]);
  const setPage: SetPage = (key, page) => setPages((p) => ({ ...p, [key]: page }));
  const maxCaller = Math.max(0, ...view.nodes.filter((n) => n.side === 'caller').map((n) => n.level));
  const nodes = view.nodes.map((n) => nodeSpec(n, maxCaller, props, view.groups, setPage));
  const edges: GraphEdgeSpec[] = view.edges.map((e) => ({ id: `${e.src}->${e.dst}`, source: e.src, target: e.dst, tone: 'normal' }));
  const click = (id: string) => {
    const n = state.nodes[id];
    if (n && n.side !== 'center') onCenter(n);
  };
  const dbl = (id: string) => {
    const n = state.nodes[id];
    if (n) onOpen(n);
  };
  return (
    <>
      <CenterPagers state={state} groups={view.groups} setPage={setPage} />
      <FlowGraph nodes={nodes} edges={edges} onNodeClick={click} onNodeDoubleClick={dbl} height={520} testId="neighbor-graph" />
    </>
  );
}
