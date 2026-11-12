import { traverse } from '../graph/traverse.js';
import type { SnapshotRow, SymbolRow } from '../model/types.js';
import type { CallerSummary, EdgeChange, EntryInfo, ImpactSummary, SymbolRef } from '../report/types.js';
import type { Store } from '../store/db.js';
import type { SymbolDiff } from './symbol-diff.js';

const TOP_PROD_CALLERS = 5;

/** 一个版本的快照：符号全集，以及解析是否成功（失败时没有边，调用方和边变化都不计算） */
export interface GraphSide {
  store: Store;
  snapshotId: number;
  resolved: boolean;
  /** id → 符号（不含 norm_tokens） */
  symbols: Map<string, SymbolRow>;
  entries: Map<string, EntryInfo>;
}

/**
 * 载入一个版本的符号和入口。snap 为 undefined（与空树比较、跳过构建）时为空快照：
 * 没有符号也没有边，按解析成功处理，不产生 resolver warning
 */
export function loadGraphSide(store: Store, snap: SnapshotRow | undefined): GraphSide {
  if (!snap) return { store, snapshotId: -1, resolved: true, symbols: new Map(), entries: new Map() };
  const entries = new Map<string, EntryInfo>();
  for (const e of store.getEntries(snap.id)) {
    if (!entries.has(e.symbolId)) entries.set(e.symbolId, { kind: e.kind, framework: e.framework, detail: e.detail });
  }
  return {
    store, snapshotId: snap.id, resolved: snap.resolverStatus === 'ok',
    symbols: new Map(store.getSymbols(snap.id).map((s) => [s.id, s])), entries,
  };
}

/** entries 给出时带上该符号的入口信息（图上要标出 HTTP 接口的地方用） */
export function symbolRef(s: SymbolRow, entries?: Map<string, EntryInfo>): SymbolRef {
  const entry = entries?.get(s.id);
  return {
    key: s.symbolKey, id: s.id, kind: s.kind, name: s.name, qualifiedName: s.qualifiedName, path: s.path, startLine: s.startLine, isTest: s.isTest,
    ...(s.modelKind ? { modelKind: s.modelKind } : {}),
    ...(entry ? { entry } : {}),
  };
}

export const EMPTY_CALLERS: CallerSummary = { prod: 0, test: 0, topProd: [] };

/**
 * 直接调用方：只算 call 边，按不同的调用符号计数，自己调用自己不算。
 * 正式代码调用方按调用点数量从多到少列出前 5 个。
 */
export function callerSummaries(side: GraphSide, ids: string[]): Map<string, CallerSummary> {
  const out = new Map<string, CallerSummary>();
  if (!side.resolved || ids.length === 0) return out;
  const result = traverse(side.store, side.snapshotId, ids, { direction: 'callers', depth: 1, edgeKinds: ['call'] });
  const sites = new Map<string, number>();
  for (const e of result.edges) sites.set(`${e.dstId}\0${e.srcId}`, (sites.get(`${e.dstId}\0${e.srcId}`) ?? 0) + 1);
  for (const [origin, reached] of result.reached) {
    const callers = [...reached.keys()].map((id) => result.symbols.get(id)!);
    const prod = callers.filter((c) => !c.isTest);
    const top = prod
      .map((c) => ({ c, n: sites.get(`${origin}\0${c.id}`) ?? 0 }))
      .sort((a, b) => b.n - a.n || a.c.symbolKey.localeCompare(b.c.symbolKey))
      .slice(0, TOP_PROD_CALLERS)
      .map(({ c }) => symbolRef(c, side.entries));
    out.set(origin, { prod: prod.length, test: callers.length - prod.length, topProd: top });
  }
  return out;
}

/** 影响面：沿 call 和 reference 边向上 depth 层，按正式代码和测试代码分别计数 */
export function impactSummaries(side: GraphSide, ids: string[], depth: number): Map<string, ImpactSummary> {
  const out = new Map<string, ImpactSummary>();
  if (!side.resolved || ids.length === 0) return out;
  const result = traverse(side.store, side.snapshotId, ids, { direction: 'callers', depth, edgeKinds: ['call', 'reference'] });
  for (const [origin, reached] of result.reached) {
    let prod = 0;
    let test = 0;
    for (const id of reached.keys()) {
      if (result.symbols.get(id)!.isTest) test++;
      else prod++;
    }
    out.set(origin, { depth, prod, test });
  }
  return out;
}

interface OutEdge {
  kind: string;
  dst: SymbolRow;
}

/** 一组符号的出边，按 src 分组、按 (kind, 目标 key) 去重；目标 key 经 normalizeKey 换算 */
function outEdges(side: GraphSide, ids: string[], normalizeKey: (key: string) => string): Map<string, Map<string, OutEdge>> {
  const out = new Map<string, Map<string, OutEdge>>();
  for (const e of side.store.getEdgesForSymbols(side.snapshotId, ids, 'out')) {
    const dst = side.symbols.get(e.dstId);
    if (!dst || e.srcId === e.dstId) continue;
    let m = out.get(e.srcId);
    if (!m) out.set(e.srcId, (m = new Map()));
    m.set(`${e.kind}\0${normalizeKey(dst.symbolKey)}`, { kind: e.kind, dst });
  }
  return out;
}

/**
 * 调用边变化：对每个改动符号，比较两个版本出边的 (kind, 目标 symbol_key) 集合。
 * base 里的目标如果本次搬了家，先换成 head 里的 key，搬家本身不算边变化。
 */
export function edgeChanges(diffs: SymbolDiff[], base: GraphSide, head: GraphSide): EdgeChange[] {
  if (!base.resolved || !head.resolved) return [];
  const movedTo = new Map(diffs.filter((d) => d.change === 'moved').map((d) => [d.base!.symbolKey, d.head!.symbolKey]));
  const baseOut = outEdges(base, diffs.flatMap((d) => (d.base ? [d.base.id] : [])), (k) => movedTo.get(k) ?? k);
  const headOut = outEdges(head, diffs.flatMap((d) => (d.head ? [d.head.id] : [])), (k) => k);
  const changes: EdgeChange[] = [];
  for (const d of diffs) {
    const before = d.base ? (baseOut.get(d.base.id) ?? new Map<string, OutEdge>()) : new Map<string, OutEdge>();
    const after = d.head ? (headOut.get(d.head.id) ?? new Map<string, OutEdge>()) : new Map<string, OutEdge>();
    for (const [k, e] of after) {
      if (!before.has(k)) changes.push({ src: symbolRef(d.head!, head.entries), dst: symbolRef(e.dst, head.entries), kind: e.kind, change: 'added' });
    }
    for (const [k, e] of before) {
      if (!after.has(k)) changes.push({ src: symbolRef(d.base!, base.entries), dst: symbolRef(e.dst, base.entries), kind: e.kind, change: 'removed' });
    }
  }
  return changes;
}
