import type { SymbolInfo, TreeResponse } from '../api/types';

export type Side = 'center' | 'caller' | 'callee';
export type NeighborSide = Exclude<Side, 'center'>;

export interface NNode {
  info: SymbolInfo;
  side: Side;
  /** 离中心的层数，中心为 0 */
  level: number;
  /** 已经加载过它这一侧的下一层 */
  expanded: boolean;
  /** 展开哪个节点时加进来的（中心的直接调用方 / 被调用方为中心）；中心为 null */
  parent: string | null;
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

/** 每个节点在每个方向上的下一层按这个大小分页 */
export const PAGE_SIZE = 5;

/** 某个节点某一方向的下一层所在的分页组 */
export function groupKey(side: NeighborSide, parentId: string): string {
  return `${side}:${parentId}`;
}

/** 新节点挂在哪个节点下：第 1 层挂在查询的根上，更深的挂在与它相连、浅一层的节点上 */
function parentOf(n: TreeResponse['nodes'][number], tree: TreeResponse, depthOf: Map<string, number>, side: NeighborSide): string {
  if (n.depth <= 1) return tree.root.id;
  const edge = tree.edges.find((e) => {
    const [near, far] = side === 'caller' ? [e.srcId, e.dstId] : [e.dstId, e.srcId];
    return near === n.id && depthOf.get(far) === n.depth - 1;
  });
  return edge ? (side === 'caller' ? edge.dstId : edge.srcId) : tree.root.id;
}

/** 把一次 callers / callees 查询的结果并入图：已有的节点保持原来的方向、层数和所属节点 */
export function mergeTree(state: NeighborState, tree: TreeResponse, side: NeighborSide): NeighborState {
  const base = state.nodes[tree.root.id]?.level ?? 0;
  const nodes = { ...state.nodes };
  const edges = { ...state.edges };
  const depthOf = new Map(tree.nodes.map((n) => [n.id, n.depth]));
  for (const n of tree.nodes) {
    if (!nodes[n.id]) nodes[n.id] = { info: n, side, level: base + n.depth, expanded: false, parent: parentOf(n, tree, depthOf, side) };
  }
  const root = nodes[tree.root.id];
  if (root && root.side !== 'center') nodes[tree.root.id] = { ...root, expanded: true };
  for (const e of tree.edges) edges[`${e.srcId}->${e.dstId}`] = { src: e.srcId, dst: e.dstId, kind: e.kind };
  return { ...state, nodes, edges };
}

/**
 * 以 center 为中心的初始图：1 层调用方，callees.depth 层被调用方。
 * 被调用方查了多层时，比最深一层浅的节点都已加载过下一层，标为已展开。
 */
export function initNeighbors(snapshotId: number, callers: TreeResponse, callees: TreeResponse): NeighborState {
  const center: NNode = { info: callers.root, side: 'center', level: 0, expanded: true, parent: null };
  const empty: NeighborState = { snapshotId, centerId: callers.root.id, nodes: { [callers.root.id]: center }, edges: {} };
  const state = mergeTree(mergeTree(empty, callers, 'caller'), callees, 'callee');
  const nodes = { ...state.nodes };
  for (const [id, n] of Object.entries(nodes)) {
    if (n.side === 'callee' && n.level < callees.depth) nodes[id] = { ...n, expanded: true };
  }
  return { ...state, nodes };
}

export interface ViewOptions {
  showTests: boolean;
  showModels: boolean;
  /** 分页组 → 页码（从 0 开始），没有的为第 1 页 */
  pages: Record<string, number>;
}

/** 一个分页组：某个可见节点某一方向的下一层 */
export interface PageGroup {
  key: string;
  side: NeighborSide;
  parentId: string;
  /** 当前页，从 0 开始，已按页数修正 */
  page: number;
  pages: number;
  /** 按开关过滤后的个数 */
  total: number;
  /** 因"显示模型"关闭而隐藏的模型个数 */
  hiddenModels: number;
}

export interface VisibleNeighbors {
  nodes: NNode[];
  edges: NEdge[];
  /** 可见节点下一层的分页组，按 key 索引；没有下一层（过滤后也没有隐藏的模型）的不在其中 */
  groups: Record<string, PageGroup>;
}

/** 同一层里正式代码在前，再按位置 */
function bySideOrder(a: NNode, b: NNode): number {
  return a.level - b.level || Number(a.info.isTest) - Number(b.info.isTest) || a.info.path.localeCompare(b.info.path) || a.info.startLine - b.info.startLine;
}

function childrenByGroup(state: NeighborState): Map<string, NNode[]> {
  const out = new Map<string, NNode[]>();
  for (const n of Object.values(state.nodes)) {
    if (n.side === 'center' || n.parent === null) continue;
    const key = groupKey(n.side, n.parent);
    out.set(key, [...(out.get(key) ?? []), n]);
  }
  for (const list of out.values()) list.sort(bySideOrder);
  return out;
}

function pageOf(key: string, side: NeighborSide, parentId: string, all: NNode[], opts: ViewOptions): { group: PageGroup; shown: NNode[] } {
  const afterTests = all.filter((n) => opts.showTests || !n.info.isTest);
  const list = opts.showModels ? afterTests : afterTests.filter((n) => !n.info.modelKind);
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const page = Math.min(Math.max(0, opts.pages[key] ?? 0), pages - 1);
  const group: PageGroup = { key, side, parentId, page, pages, total: list.length, hiddenModels: afterTests.length - list.length };
  return { group, shown: list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) };
}

/**
 * 当前要画的节点和边：从中心出发，每个可见节点在它那一侧的下一层只显示当前页（每页 PAGE_SIZE 个）。
 * 按开关隐藏测试代码和模型类（中心除外），分页按过滤后的结果算。
 */
export function visibleNeighbors(state: NeighborState, opts: ViewOptions): VisibleNeighbors {
  const children = childrenByGroup(state);
  const center = state.nodes[state.centerId]!;
  const shown: NNode[] = [center];
  const groups: Record<string, PageGroup> = {};
  for (let i = 0; i < shown.length; i++) {
    const n = shown[i]!;
    const sides: NeighborSide[] = n.side === 'center' ? ['caller', 'callee'] : [n.side];
    for (const side of sides) {
      const key = groupKey(side, n.info.id);
      const all = children.get(key);
      if (!all) continue;
      const { group, shown: page } = pageOf(key, side, n.info.id, all, opts);
      if (group.total > 0 || group.hiddenModels > 0) groups[key] = group;
      shown.push(...page);
    }
  }
  const ids = new Set(shown.map((n) => n.info.id));
  const edges = Object.values(state.edges).filter((e) => ids.has(e.src) && ids.has(e.dst) && e.src !== e.dst);
  return { nodes: shown, edges, groups };
}
