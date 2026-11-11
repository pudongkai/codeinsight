import type { EdgeKind, EdgeRow, SymbolRow } from '../model/types.js';
import type { Store } from '../store/db.js';

export type TraverseDirection = 'callers' | 'callees';

export const DEFAULT_TRAVERSE_KINDS: EdgeKind[] = ['call', 'reference'];

export interface TraverseOptions {
  direction: TraverseDirection;
  /** 层数，1 为直接调用方 / 被调用方 */
  depth: number;
  /** 沿哪些边走，默认 call + reference */
  edgeKinds?: EdgeKind[];
  /** false 时测试代码符号既不计入也不继续展开，默认 true */
  includeTests?: boolean;
}

export interface TraverseResult {
  /** 起点 id → (到达的符号 id → 最短层数)，不含起点自身 */
  reached: Map<string, Map<string, number>>;
  /** 遍历中走过的边（同一对符号多处引用时有多条），浏览视图用它画树、定位调用点 */
  edges: EdgeRow[];
  /** 起点和到达的符号 */
  symbols: Map<string, SymbolRow>;
}

interface Walk {
  store: Store;
  snapshotId: number;
  opts: TraverseOptions;
  symbols: Map<string, SymbolRow>;
}

/** 边上远离当前层的一端：查调用方时是 src，查被调用方时是 dst */
function farEnd(e: EdgeRow, direction: TraverseDirection): string {
  return direction === 'callers' ? e.srcId : e.dstId;
}

function nearEnd(e: EdgeRow, direction: TraverseDirection): string {
  return direction === 'callers' ? e.dstId : e.srcId;
}

/** 查出一层的边，补齐远端符号，按测试代码过滤；自己指向自己的边（递归）不算 */
function expandLayer(w: Walk, frontierIds: string[]): EdgeRow[] {
  const { direction } = w.opts;
  const kinds = w.opts.edgeKinds ?? DEFAULT_TRAVERSE_KINDS;
  const layer = w.store.getEdgesForSymbols(w.snapshotId, frontierIds, direction === 'callers' ? 'in' : 'out', kinds);
  const missing = [...new Set(layer.map((e) => farEnd(e, direction)))].filter((id) => !w.symbols.has(id));
  for (const s of w.store.getSymbolsByIds(w.snapshotId, missing)) w.symbols.set(s.id, s);
  const includeTests = w.opts.includeTests ?? true;
  return layer.filter((e) => {
    const far = w.symbols.get(farEnd(e, direction));
    return far !== undefined && far.id !== nearEnd(e, direction) && (includeTests || !far.isTest);
  });
}

function groupByNear(edges: EdgeRow[], direction: TraverseDirection): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of edges) {
    const near = nearEnd(e, direction);
    let set = out.get(near);
    if (!set) out.set(near, (set = new Set()));
    set.add(farEnd(e, direction));
  }
  return out;
}

/** 每个起点从自己的前沿走一步，记录第一次到达的层数，返回新的前沿 */
function advance(
  frontier: Map<string, Set<string>>, byNear: Map<string, Set<string>>, reached: TraverseResult['reached'], depth: number,
): Map<string, Set<string>> {
  const next = new Map<string, Set<string>>();
  for (const [origin, ids] of frontier) {
    const seen = reached.get(origin)!;
    const nextIds = new Set<string>();
    for (const id of ids) {
      for (const far of byNear.get(id) ?? []) {
        if (far === origin || seen.has(far)) continue;
        seen.set(far, depth);
        nextIds.add(far);
      }
    }
    if (nextIds.size > 0) next.set(origin, nextIds);
  }
  return next;
}

/**
 * 从一组起点出发按层查调用方或被调用方（审查的影响面和浏览视图共用）。
 * 每层把所有起点的前沿合并成一次批量查询，再在内存里按起点分别推进。
 */
export function traverse(store: Store, snapshotId: number, origins: string[], opts: TraverseOptions): TraverseResult {
  const unique = [...new Set(origins)];
  const w: Walk = { store, snapshotId, opts, symbols: new Map(store.getSymbolsByIds(snapshotId, unique).map((s) => [s.id, s])) };
  const reached: TraverseResult['reached'] = new Map(unique.map((o) => [o, new Map<string, number>()]));
  const edges: EdgeRow[] = [];
  let frontier = new Map(unique.map((o) => [o, new Set([o])]));
  for (let depth = 1; depth <= opts.depth && frontier.size > 0; depth++) {
    const frontierIds = [...new Set([...frontier.values()].flatMap((s) => [...s]))];
    const layer = expandLayer(w, frontierIds);
    edges.push(...layer);
    frontier = advance(frontier, groupByNear(layer, opts.direction), reached, depth);
  }
  return { reached, edges, symbols: w.symbols };
}
