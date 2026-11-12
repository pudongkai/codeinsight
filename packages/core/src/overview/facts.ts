import { isHttpApi } from '../model/entry.js';
import type { EdgeRow, EntryRow, SymbolRow } from '../model/types.js';
import type { EntryInfo, SymbolRef } from '../report/types.js';
import { symbolRef } from '../review/impact.js';
import { addToSet } from '../util/collections.js';
import { moduleDir } from './module-id.js';
import type { ModuleIndex, PartitionModule } from './partition.js';
import type { EdgeSample, ModuleEdge, ModuleEdgeKind, ModuleInterface, ModuleModel, OverviewStats } from './types.js';
import { compareStrings } from '../util/compare.js';

/** 对外接口、数据模型各最多列出的个数 */
export const MAX_INTERFACES = 30;
export const MAX_MODELS = 30;
const MAX_EDGE_SAMPLES = 5;

/** 划分结果和快照数据整理后的图，第 2–8 步共用 */
export interface OverviewGraph {
  modules: PartitionModule[];
  index: ModuleIndex;
  symbols: Map<string, SymbolRow>;
  /** 符号 → 入口（同一符号有多个入口时优先取 HTTP 接口） */
  entries: Map<string, EntryRow>;
  /** call / reference 边，两端都是模块里的非测试符号，按 (src, dst) 去重，保留路径和行号最靠前的一条 */
  links: EdgeRow[];
  /** import 边，两端都是模块里的非测试符号 */
  imports: EdgeRow[];
  /** 符号 → 调用或引用它的不同非测试符号数（不分模块） */
  inDegree: Map<string, number>;
}

export interface GraphInput {
  symbols: SymbolRow[];
  edges: EdgeRow[];
  entries: EntryRow[];
}

function edgeOrder(a: EdgeRow, b: EdgeRow): number {
  return compareStrings(a.path, b.path) || a.line - b.line || a.col - b.col;
}

function primaryEntries(entries: EntryRow[]): Map<string, EntryRow> {
  const out = new Map<string, EntryRow>();
  for (const e of entries) {
    const cur = out.get(e.symbolId);
    if (!cur || (!isHttpApi(cur) && isHttpApi(e))) out.set(e.symbolId, e);
  }
  return out;
}

export function buildGraph(modules: PartitionModule[], index: ModuleIndex, input: GraphInput): OverviewGraph {
  const symbols = new Map(input.symbols.map((s) => [s.id, s]));
  const inModule = (id: string) => index.bySymbol.has(id) && !symbols.get(id)!.isTest;
  const links = new Map<string, EdgeRow>();
  const imports: EdgeRow[] = [];
  for (const e of [...input.edges].sort(edgeOrder)) {
    if (!inModule(e.srcId) || !inModule(e.dstId)) continue;
    if (e.kind === 'import') imports.push(e);
    else if ((e.kind === 'call' || e.kind === 'reference') && !links.has(`${e.srcId}\0${e.dstId}`)) links.set(`${e.srcId}\0${e.dstId}`, e);
  }
  const inDegree = new Map<string, number>();
  for (const e of links.values()) if (e.srcId !== e.dstId) inDegree.set(e.dstId, (inDegree.get(e.dstId) ?? 0) + 1);
  return { modules, index, symbols, entries: primaryEntries(input.entries), links: [...links.values()], imports, inDegree };
}

export function moduleOfSymbol(g: OverviewGraph, symbolId: string): string | undefined {
  return g.index.bySymbol.get(symbolId);
}

/** 报告里的符号引用，带入口信息（界面据此标出 HTTP 接口） */
export function refOf(g: OverviewGraph, s: SymbolRow): SymbolRef {
  const e = g.entries.get(s.id);
  const info: Map<string, EntryInfo> | undefined = e ? new Map([[s.id, { kind: e.kind, framework: e.framework, detail: e.detail }]]) : undefined;
  return symbolRef(s, info);
}

export function sampleOf(g: OverviewGraph, e: EdgeRow): EdgeSample {
  return { src: refOf(g, g.symbols.get(e.srcId)!), dst: refOf(g, g.symbols.get(e.dstId)!), path: e.path, line: e.line };
}

export function isHttpHandler(g: OverviewGraph, symbolId: string): boolean {
  return isHttpApi(g.entries.get(symbolId));
}

// ---------- 模块间依赖 ----------

interface EdgeAcc {
  from: string;
  to: string;
  links: EdgeRow[];
  kinds: Set<ModuleEdgeKind>;
}

function accumulate(acc: Map<string, EdgeAcc>, from: string, to: string): EdgeAcc {
  const key = `${from}\0${to}`;
  let a = acc.get(key);
  if (!a) acc.set(key, (a = { from, to, links: [], kinds: new Set() }));
  return a;
}

/**
 * 模块间依赖（第 2 步）：call / reference 边计入 weight（不同的符号对数），samples 按被调用方入度从高到低取 5 个；
 * import 边只在 kinds 里标出有导入关系。inCycle 由边界检查填写。
 */
export function moduleEdges(g: OverviewGraph): ModuleEdge[] {
  const acc = new Map<string, EdgeAcc>();
  for (const e of g.links) {
    const [from, to] = [moduleOfSymbol(g, e.srcId)!, moduleOfSymbol(g, e.dstId)!];
    if (from === to) continue;
    const a = accumulate(acc, from, to);
    a.links.push(e);
    a.kinds.add(e.kind as ModuleEdgeKind);
  }
  for (const e of g.imports) {
    const [from, to] = [moduleOfSymbol(g, e.srcId)!, moduleOfSymbol(g, e.dstId)!];
    if (from !== to) accumulate(acc, from, to).kinds.add('import');
  }
  const kindOrder: ModuleEdgeKind[] = ['call', 'reference', 'import'];
  return [...acc.values()]
    .map((a) => ({
      from: a.from, to: a.to, weight: a.links.length,
      kinds: kindOrder.filter((k) => a.kinds.has(k)),
      samples: topLinks(g, sampleCandidates(g, a.links), MAX_EDGE_SAMPLES).map((e) => sampleOf(g, e)),
      inCycle: false,
    }))
    .sort((x, y) => compareStrings(x.from, y.from) || compareStrings(x.to, y.to));
}

/** 示例优先取指向函数、类的边；指向 module 符号的引用（`mod.f()` 里的 `mod`）只在没有其他边时使用 */
function sampleCandidates(g: OverviewGraph, links: EdgeRow[]): EdgeRow[] {
  const direct = links.filter((e) => g.symbols.get(e.dstId)!.kind !== 'module');
  return direct.length > 0 ? direct : links;
}

/** 按被调用方入度从高到低，相同时按调用方、被调用方 key */
export function topLinks(g: OverviewGraph, links: EdgeRow[], n: number): EdgeRow[] {
  const key = (id: string) => g.symbols.get(id)!.symbolKey;
  return [...links]
    .sort((a, b) => (g.inDegree.get(b.dstId) ?? 0) - (g.inDegree.get(a.dstId) ?? 0) || compareStrings(key(a.srcId), key(b.srcId)) || compareStrings(key(a.dstId), key(b.dstId)))
    .slice(0, n);
}

// ---------- 模块内的符号 ----------

export function moduleSymbols(g: OverviewGraph, moduleId: string): SymbolRow[] {
  return [...g.symbols.values()].filter((s) => !s.isTest && s.kind !== 'module' && moduleOfSymbol(g, s.id) === moduleId);
}

function byKey(a: SymbolRow, b: SymbolRow): number {
  return compareStrings(a.symbolKey, b.symbolKey);
}

/** 对外接口（报告展示用）：被其他模块调用或引用过的非私有符号，加上本模块的入口函数 */
export function moduleInterfaces(g: OverviewGraph, moduleId: string): ModuleInterface[] {
  const srcs = new Map<string, Set<string>>();
  const fromModules = new Map<string, Set<string>>();
  for (const e of g.links) {
    const from = moduleOfSymbol(g, e.srcId)!;
    if (moduleOfSymbol(g, e.dstId) !== moduleId || from === moduleId) continue;
    addToSet(srcs, e.dstId, e.srcId);
    addToSet(fromModules, e.dstId, from);
  }
  const picked = moduleSymbols(g, moduleId).filter((s) => g.entries.has(s.id) || (srcs.has(s.id) && !s.name.startsWith('_')));
  const rows = picked.map((s) => ({ s, http: isHttpHandler(g, s.id), inbound: srcs.get(s.id)?.size ?? 0, from: [...(fromModules.get(s.id) ?? [])].sort() }));
  rows.sort((a, b) => Number(b.http) - Number(a.http) || b.from.length - a.from.length || b.inbound - a.inbound || byKey(a.s, b.s));
  return rows.slice(0, MAX_INTERFACES).map((r) => ({ symbol: refOf(g, r.s), inbound: r.inbound, fromModules: r.from }));
}

function isModelClass(s: SymbolRow): boolean {
  return s.kind === 'class' && s.modelKind !== null;
}

/** 数据模型（报告展示用）：model_kind 非空的类，按被引用次数（含其他模块）、key 排序 */
export function moduleModels(g: OverviewGraph, moduleId: string): ModuleModel[] {
  return moduleSymbols(g, moduleId)
    .filter(isModelClass)
    .sort((a, b) => (g.inDegree.get(b.id) ?? 0) - (g.inDegree.get(a.id) ?? 0) || byKey(a, b))
    .slice(0, MAX_MODELS)
    .map((s) => ({ symbol: refOf(g, s) }));
}

/** 本模块内的符号对 dst 的不同调用方或引用方；kinds 不传时 call 和 reference 都算 */
function ownCallers(g: OverviewGraph, moduleId: string, kinds?: ReadonlySet<string>): Map<string, Set<string>> {
  const own = new Map<string, Set<string>>();
  for (const e of g.links) {
    if ((kinds && !kinds.has(e.kind)) || e.srcId === e.dstId || moduleOfSymbol(g, e.srcId) !== moduleId || moduleOfSymbol(g, e.dstId) !== moduleId) continue;
    addToSet(own, e.dstId, e.srcId);
  }
  return own;
}

/**
 * 模块摘要输入用的数据模型：按本模块内的引用数、key 排序取前 MAX_MODELS 个。
 * 不用跨模块的引用数，其他模块新引用这里的模型不会改变输入。
 */
export function rankedOwnModels(g: OverviewGraph, moduleId: string): SymbolRow[] {
  const own = ownCallers(g, moduleId);
  return moduleSymbols(g, moduleId)
    .filter(isModelClass)
    .sort((a, b) => (own.get(b.id)?.size ?? 0) - (own.get(a.id)?.size ?? 0) || byKey(a, b))
    .slice(0, MAX_MODELS);
}

function isPublic(g: OverviewGraph, s: SymbolRow): boolean {
  if (s.name.startsWith('_')) return false;
  if (s.parentId === null) return s.kind === 'function' || s.kind === 'class';
  const parent = g.symbols.get(s.parentId);
  return s.kind === 'method' && parent?.kind === 'class' && parent.parentId === null && !parent.name.startsWith('_');
}

const CALL_ONLY: ReadonlySet<string> = new Set(['call']);

/**
 * 本模块的公开符号（非 `_` 开头的顶层函数、类和公开类的公开方法）加上 HTTP 接口，
 * 按“HTTP 接口优先 → 本模块内的调用方数 → key”排序。只看本模块的代码，其他模块的改动不影响结果。
 * 源码片段和模块摘要输入共用这个顺序。
 */
export function rankedOwnSymbols(g: OverviewGraph, moduleId: string): SymbolRow[] {
  const own = ownCallers(g, moduleId, CALL_ONLY);
  const rows = moduleSymbols(g, moduleId)
    .filter((s) => isHttpHandler(g, s.id) || isPublic(g, s))
    .map((s) => ({ s, http: isHttpHandler(g, s.id), callers: own.get(s.id)?.size ?? 0 }));
  rows.sort((a, b) => Number(b.http) - Number(a.http) || b.callers - a.callers || byKey(a.s, b.s));
  return rows.map((r) => r.s);
}

/** 模块的目录：自身所在目录加上合并进来的模块的目录 */
export function moduleDirs(m: PartitionModule): string[] {
  return [...new Set([m.dir, ...m.mergedFrom.map(moduleDir)])].sort();
}

/** 模块文件的总行数，按文件的 module 符号的末行计 */
export function moduleLines(g: OverviewGraph, m: PartitionModule): number {
  const files = new Set(m.files);
  let n = 0;
  for (const s of g.symbols.values()) if (s.kind === 'module' && files.has(s.path)) n += s.endLine;
  return n;
}

export function overviewStats(g: OverviewGraph, files: number, testFiles: number): OverviewStats {
  let functions = 0;
  let httpApis = 0;
  let models = 0;
  for (const s of g.symbols.values()) {
    if (s.isTest || !g.index.bySymbol.has(s.id)) continue;
    if (s.kind === 'function' || s.kind === 'method') functions++;
    if (isHttpHandler(g, s.id)) httpApis++;
    if (s.kind === 'class' && s.modelKind) models++;
  }
  return { files, testFiles, modules: g.modules.length, functions, httpApis, models };
}

/** 各模块的 HTTP 接口数（不含测试） */
export function httpApisByModule(g: OverviewGraph): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of g.entries.keys()) {
    const m = moduleOfSymbol(g, id);
    if (m !== undefined && isHttpHandler(g, id) && !g.symbols.get(id)!.isTest) out.set(m, (out.get(m) ?? 0) + 1);
  }
  return out;
}
