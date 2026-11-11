import type { SymbolInfo, TreeResponse } from '../api/types';

export type Side = 'center' | 'caller' | 'callee';

export interface NNode {
  info: SymbolInfo;
  side: Side;
  /** 离中心的层数，中心为 0 */
  level: number;
  /** 已经加载过它这一侧的下一层 */
  expanded: boolean;
}

export interface NEdge {
  src: string;
  dst: string;
  kind: string;
}

export interface NeighborState {
  snapshotId: number;
  centerId: string;
  nodes: Record<string, NNode>;
  edges: Record<string, NEdge>;
}

/** 单个方向超过这么多个节点时，多出的折叠成"还有 N 个" */
export const MAX_PER_SIDE = 30;

/** 把一次 callers / callees 查询的结果并入图：已有的节点保持原来的方向和层数 */
export function mergeTree(state: NeighborState, tree: TreeResponse, side: Exclude<Side, 'center'>): NeighborState {
  const base = state.nodes[tree.root.id]?.level ?? 0;
  const nodes = { ...state.nodes };
  const edges = { ...state.edges };
  for (const n of tree.nodes) {
    if (!nodes[n.id]) nodes[n.id] = { info: n, side, level: base + n.depth, expanded: false };
  }
  const root = nodes[tree.root.id];
  if (root && root.side !== 'center') nodes[tree.root.id] = { ...root, expanded: true };
  for (const e of tree.edges) edges[`${e.srcId}->${e.dstId}`] = { src: e.srcId, dst: e.dstId, kind: e.kind };
  return { ...state, nodes, edges };
}

/** 以 center 为中心的初始图：各 1 层调用方和被调用方 */
export function initNeighbors(snapshotId: number, callers: TreeResponse, callees: TreeResponse): NeighborState {
  const center: NNode = { info: callers.root, side: 'center', level: 0, expanded: true };
  const empty: NeighborState = { snapshotId, centerId: callers.root.id, nodes: { [callers.root.id]: center }, edges: {} };
  return mergeTree(mergeTree(empty, callers, 'caller'), callees, 'callee');
}

export interface VisibleNeighbors {
  nodes: NNode[];
  edges: NEdge[];
  /** 折叠掉的节点，按方向 */
  overflow: Record<'caller' | 'callee', NNode[]>;
}

function bySideOrder(a: NNode, b: NNode): number {
  return a.level - b.level || a.info.path.localeCompare(b.info.path) || a.info.startLine - b.info.startLine;
}

/** 当前要画的节点和边：按开关隐藏测试代码（中心除外），每个方向最多 MAX_PER_SIDE 个 */
export function visibleNeighbors(state: NeighborState, showTests: boolean): VisibleNeighbors {
  const all = Object.values(state.nodes).filter((n) => n.side === 'center' || showTests || !n.info.isTest);
  const shown: NNode[] = all.filter((n) => n.side === 'center');
  const overflow: VisibleNeighbors['overflow'] = { caller: [], callee: [] };
  for (const side of ['caller', 'callee'] as const) {
    const list = all.filter((n) => n.side === side).sort(bySideOrder);
    shown.push(...list.slice(0, MAX_PER_SIDE));
    overflow[side] = list.slice(MAX_PER_SIDE);
  }
  const ids = new Set(shown.map((n) => n.info.id));
  const edges = Object.values(state.edges).filter((e) => ids.has(e.src) && ids.has(e.dst) && e.src !== e.dst);
  return { nodes: shown, edges, overflow };
}
