import path from 'node:path';
import { log } from '../log.js';
import type { EdgeRow, FileRow, SnapshotKind, SymbolRow } from '../model/types.js';
import type { Warning } from '../report/types.js';
import type { Store } from '../store/db.js';
import { pushTo } from '../util/collections.js';
import { compareStrings } from '../util/compare.js';
import { fileStem } from '../util/paths.js';
import {
  applicableRecord, sameDecisions, startRecord, withinRecordedRange,
  type DirDecision, type DirectDecision, type PartitionRecord, type PartitionThresholds,
} from './partition-state.js';

/** 计入规模的符号类型 */
const SIZED_KINDS = new Set(['function', 'method', 'class']);
/** 仓库根目录在记录里的 key */
const ROOT = '.';
/** 没有任何模块覆盖的文件归入的模块，也是根目录直接文件组的 id */
const REST_ID = '*';

/** dir：整个目录；files：目录直接放的文件；cluster：按文件拆出的一组；rest：兜底的 `*` */
export type PartitionModuleKind = 'dir' | 'files' | 'cluster' | 'rest';

export interface PartitionModule {
  id: string;
  /** 模块所在目录，根目录为 `.` */
  dir: string;
  kind: PartitionModuleKind;
  /** 参与划分的文件（含没有符号的文件），按路径排序 */
  files: string[];
  /** 非测试的 function、method、class 数 */
  size: number;
  /** 合并进来的过碎模块 id */
  mergedFrom: string[];
}

/** 文件、符号到模块 id 的对应 */
export interface ModuleIndex {
  byPath: Map<string, string>;
  bySymbol: Map<string, string>;
}

export interface PartitionStats {
  /** 参与划分的文件数 */
  files: number;
  /** 其中没有计入规模的符号的文件数 */
  emptyFiles: number;
  testFiles: number;
}

export interface PartitionResult {
  /** 按 id 排序 */
  modules: PartitionModule[];
  index: ModuleIndex;
  /** 要写回的划分记录 */
  record: PartitionRecord;
  /** 记录的决定和读入的不同（需要写回） */
  recordChanged: boolean;
  stats: PartitionStats;
  warnings: Warning[];
}

export interface PartitionInput {
  files: FileRow[];
  symbols: SymbolRow[];
  edges: EdgeRow[];
  thresholds: PartitionThresholds;
  record?: PartitionRecord;
  source?: { kind: SnapshotKind; commitSha: string };
  now?: number;
}

/** 文件 → 文件 → 边数（对称） */
type FileGraph = Map<string, Map<string, number>>;

interface DirNode {
  path: string;
  /** 直接放的、规模大于 0 的文件 */
  files: string[];
  /** 含规模大于 0 的文件的子目录 */
  children: string[];
  size: number;
}

interface Draft {
  id: string;
  dir: string;
  kind: PartitionModuleKind;
  files: string[];
  /** 兄弟模块所在的目录（合并时在这个范围里找目标）；根目录整体成模块时没有 */
  scope?: string;
  mergedFrom: string[];
}

interface Ctx {
  th: PartitionThresholds;
  old?: PartitionRecord;
  rec: PartitionRecord;
  fileSize: Map<string, number>;
  tree: Map<string, DirNode>;
  /** call / reference 边：第一次划分、按文件拆、合并都只看它 */
  callGraph: FileGraph;
  /** 再加上 import 边：没有符号的文件的边主要是 import */
  linkGraph: FileGraph;
  decisions: Map<string, DirDecision>;
  modules: Map<string, Draft>;
  /** 合并前创建过的全部模块 */
  created: Map<string, Draft>;
  mergedInto: Map<string, string>;
}

// ---------- 路径与 id ----------


function dirOf(file: string): string {
  return path.posix.dirname(file);
}

function parentDir(dir: string): string | undefined {
  return dir === ROOT ? undefined : path.posix.dirname(dir);
}

function wholeId(dir: string): string {
  return dir === ROOT ? REST_ID : dir;
}

/** 没有子目录时 whole 和 split 得到同一组文件，id 也相同，阈值附近、记录重置时不会换 id */
function directId(node: DirNode): string {
  if (node.children.length === 0) return wholeId(node.path);
  return node.path === ROOT ? REST_ID : `${node.path}/*`;
}

// ---------- 输入整理 ----------

function participates(f: FileRow): boolean {
  return (f.supportLevel === 'full' || f.supportLevel === 'structure') && !f.isTest && !f.isGenerated;
}

function fileSizes(files: string[], symbols: SymbolRow[]): Map<string, number> {
  const sizes = new Map(files.map((f) => [f, 0]));
  for (const s of symbols) {
    if (s.isTest || !SIZED_KINDS.has(s.kind)) continue;
    const cur = sizes.get(s.path);
    if (cur !== undefined) sizes.set(s.path, cur + 1);
  }
  return sizes;
}

function addEdge(g: FileGraph, a: string, b: string): void {
  for (const [x, y] of [[a, b], [b, a]] as const) {
    let m = g.get(x);
    if (!m) g.set(x, (m = new Map()));
    m.set(y, (m.get(y) ?? 0) + 1);
  }
}

/** 两端都是参与划分文件里的非测试符号、且在不同文件的边，按文件聚合 */
function fileGraphs(symbols: SymbolRow[], edges: EdgeRow[], included: Set<string>): { callGraph: FileGraph; linkGraph: FileGraph } {
  const fileOf = new Map(symbols.filter((s) => !s.isTest && included.has(s.path)).map((s) => [s.id, s.path]));
  const callGraph: FileGraph = new Map();
  const linkGraph: FileGraph = new Map();
  for (const e of edges) {
    if (e.kind !== 'call' && e.kind !== 'reference' && e.kind !== 'import') continue;
    const a = fileOf.get(e.srcId);
    const b = fileOf.get(e.dstId);
    if (!a || !b || a === b) continue;
    addEdge(linkGraph, a, b);
    if (e.kind !== 'import') addEdge(callGraph, a, b);
  }
  return { callGraph, linkGraph };
}

function edgesBetween(g: FileGraph, a: Iterable<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const f of a) for (const [other, c] of g.get(f) ?? []) if (b.has(other)) n += c;
  return n;
}

/** 只用规模大于 0 的文件建目录树：没有符号的文件不影响整体 / 拆开 / 合并判断 */
function buildTree(fileSize: Map<string, number>): Map<string, DirNode> {
  const tree = new Map<string, DirNode>();
  const node = (p: string): DirNode => {
    let n = tree.get(p);
    if (!n) tree.set(p, (n = { path: p, files: [], children: [], size: 0 }));
    return n;
  };
  node(ROOT);
  for (const [file, size] of [...fileSize].sort(([a], [b]) => compareStrings(a, b))) {
    if (size === 0) continue;
    node(dirOf(file)).files.push(file);
    for (let d: string | undefined = dirOf(file); d !== undefined; d = parentDir(d)) {
      node(d).size += size;
      const p = parentDir(d);
      if (p !== undefined && !node(p).children.includes(d)) node(p).children.push(d);
    }
  }
  for (const n of tree.values()) n.children.sort(compareStrings);
  return tree;
}

// ---------- 整体还是拆开 ----------

function sizeOf(ctx: Ctx, files: Iterable<string>): number {
  let n = 0;
  for (const f of files) n += ctx.fileSize.get(f) ?? 0;
  return n;
}

function addModule(ctx: Ctx, d: Omit<Draft, 'mergedFrom'>): void {
  const draft = { ...d, files: [...d.files], mergedFrom: [] };
  ctx.modules.set(d.id, draft);
  ctx.created.set(d.id, draft);
}

/** 记录里有决定且规模在记录规模的 0.5–2 倍内时照记录（sizes 不变）；否则重新判断并更新 sizes */
function decideDir(ctx: Ctx, node: DirNode): DirDecision {
  const recorded = ctx.old?.dirs[node.path];
  const base = ctx.old?.sizes[node.path];
  if (recorded && base !== undefined && withinRecordedRange(node.size, base)) return recorded;
  const decision: DirDecision = node.size <= ctx.th.moduleMaxSize ? 'whole' : 'split';
  ctx.rec.dirs[node.path] = decision;
  ctx.rec.sizes[node.path] = node.size;
  if (recorded) log.info('partition_dir_rejudged', { dir: node.path, from: recorded, to: decision, recordedSize: base, size: node.size });
  return decision;
}

/** 直接放的文件是否按文件拆：和目录一样照记录，超出记录规模的 0.5–2 倍才重新按 leafSplitSize 判断 */
function decideDirect(ctx: Ctx, node: DirNode): DirectDecision {
  const size = sizeOf(ctx, node.files);
  const recorded = ctx.old?.direct?.[node.path];
  const base = ctx.old?.directSizes?.[node.path];
  if (recorded && base !== undefined && withinRecordedRange(size, base)) return recorded;
  const decision: DirectDecision = size > ctx.th.leafSplitSize ? 'clusters' : 'files';
  (ctx.rec.direct ??= {})[node.path] = decision;
  (ctx.rec.directSizes ??= {})[node.path] = size;
  if (recorded) log.info('partition_direct_rejudged', { dir: node.path, from: recorded, to: decision, recordedSize: base, size });
  return decision;
}

function filesUnder(ctx: Ctx, node: DirNode): string[] {
  return [...node.files, ...node.children.flatMap((c) => filesUnder(ctx, ctx.tree.get(c)!))];
}

function visitDir(ctx: Ctx, dir: string): void {
  const node = ctx.tree.get(dir)!;
  const decision = decideDir(ctx, node);
  ctx.decisions.set(dir, decision);
  if (decision === 'whole') {
    addModule(ctx, { id: wholeId(dir), dir, kind: 'dir', files: filesUnder(ctx, node), scope: parentDir(dir) });
    return;
  }
  for (const child of node.children) visitDir(ctx, child);
  if (node.files.length === 0) return;
  if (decideDirect(ctx, node) === 'clusters') {
    splitByFiles(ctx, node);
    return;
  }
  const id = directId(node);
  addModule(ctx, { id, dir, kind: 'files', files: node.files, scope: id === wholeId(dir) ? parentDir(dir) : dir });
}

// ---------- 按文件拆 ----------

/** 按文件拆出的组的 id 前缀：`<目录>#`，根目录为 `#` */
function clusterIdPrefix(dir: string): string {
  return dir === ROOT ? '#' : `${dir}#`;
}

function splitByFiles(ctx: Ctx, node: DirNode): void {
  let groups = recordedClusters(ctx, node);
  const over = groups && [...groups].find(([id, files]) => sizeOf(ctx, files) > 2 * (ctx.old?.sizes[id] ?? 0));
  if (over) log.info('partition_dir_reclustered', { dir: node.path, group: over[0], recordedSize: ctx.old?.sizes[over[0]], size: sizeOf(ctx, over[1]) });
  if (!groups || over) groups = freshClusters(ctx, node);
  for (const [id, files] of [...groups].sort(([a], [b]) => compareStrings(a, b))) {
    addModule(ctx, { id, dir: node.path, kind: 'cluster', files: files.sort(compareStrings), scope: node.path });
  }
}

/** 照记录 clusters 分组；新文件归到与它 call / reference 边最多的组，没有边时归到规模最小的组 */
function recordedClusters(ctx: Ctx, node: DirNode): Map<string, string[]> | undefined {
  const groups = new Map<string, string[]>();
  const fresh: string[] = [];
  for (const f of node.files) {
    const id = ctx.old?.clusters[f];
    if (id?.startsWith(clusterIdPrefix(node.path))) pushTo(groups, id, f);
    else fresh.push(f);
  }
  if (groups.size === 0) return undefined;
  for (const f of fresh) {
    const id = pickGroup(ctx, ctx.callGraph, f, groups, 'smallest');
    groups.get(id)!.push(f);
    ctx.rec.clusters[f] = id;
    log.debug('partition_file_assigned', { file: f, module: id });
  }
  return groups;
}

/** 边最多的组；都没有边时按 fallback 取规模最小或最大的组；相同时取 id 字典序靠前的 */
function pickGroup(ctx: Ctx, g: FileGraph, file: string, groups: Map<string, string[]>, fallback: 'smallest' | 'largest'): string {
  const ids = [...groups.keys()].sort(compareStrings);
  let best: { id: string; edges: number } | undefined;
  for (const id of ids) {
    const edges = edgesBetween(g, [file], new Set(groups.get(id)));
    if (edges > 0 && (!best || edges > best.edges)) best = { id, edges };
  }
  if (best) return best.id;
  const sign = fallback === 'smallest' ? 1 : -1;
  return ids.reduce((a, b) => (sign * (sizeOf(ctx, groups.get(b)!) - sizeOf(ctx, groups.get(a)!)) < 0 ? b : a));
}

interface Group {
  files: string[];
  size: number;
  /** 组里字典序最小的路径，用于相同得分时排序 */
  key: string;
  alive: boolean;
  /** 相邻组下标 → 组间 call / reference 边数 */
  links: Map<number, number>;
}

/** 候选合并：组间边数 / 两组规模乘积；lo、hi 是两组 key 按字典序排好，用于相同得分时排序 */
interface Candidate {
  a: number;
  b: number;
  score: number;
  lo: string;
  hi: string;
}

function before(x: Candidate, y: Candidate): boolean {
  if (x.score !== y.score) return x.score > y.score;
  return compareStrings(x.lo, y.lo) < 0 || (x.lo === y.lo && compareStrings(x.hi, y.hi) < 0);
}

/** 按 before 排序的二叉堆 */
class CandidateHeap {
  private items: Candidate[] = [];

  push(c: Candidate): void {
    const h = this.items;
    h.push(c);
    for (let i = h.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (!before(h[i]!, h[p]!)) break;
      [h[i], h[p]] = [h[p]!, h[i]!];
      i = p;
    }
  }

  pop(): Candidate | undefined {
    const h = this.items;
    const top = h[0];
    const last = h.pop();
    if (h.length === 0 || !last) return top;
    h[0] = last;
    for (let i = 0; ;) {
      const [l, r] = [2 * i + 1, 2 * i + 2];
      let m = i;
      if (l < h.length && before(h[l]!, h[m]!)) m = l;
      if (r < h.length && before(h[r]!, h[m]!)) m = r;
      if (m === i) break;
      [h[i], h[m]] = [h[m]!, h[i]!];
      i = m;
    }
    return top;
  }
}

/** 合并后不超过 moduleMaxSize 时放进候选；组只会变大，超过的以后也不会再成为候选 */
function pushCandidate(ctx: Ctx, heap: CandidateHeap, groups: Group[], a: number, b: number, edges: number): void {
  const [ga, gb] = [groups[a]!, groups[b]!];
  if (ga.size + gb.size > ctx.th.moduleMaxSize) return;
  const [lo, hi] = compareStrings(ga.key, gb.key) < 0 ? [ga.key, gb.key] : [gb.key, ga.key];
  heap.push({ a, b, score: edges / (ga.size * gb.size), lo, hi });
}

function initialGroups(ctx: Ctx, files: string[]): Group[] {
  const at = new Map(files.map((f, i) => [f, i]));
  return files.map((f) => {
    const links = new Map<number, number>();
    for (const [other, c] of ctx.callGraph.get(f) ?? []) {
      const j = at.get(other);
      if (j !== undefined) links.set(j, c);
    }
    return { files: [f], size: ctx.fileSize.get(f)!, key: f, alive: true, links };
  });
}

/** 合并两组成新组（新下标），把相邻组的边转到新组上，并为新组放入候选 */
function mergeGroups(ctx: Ctx, heap: CandidateHeap, groups: Group[], a: number, b: number): void {
  const [ga, gb] = [groups[a]!, groups[b]!];
  ga.alive = gb.alive = false;
  const id = groups.length;
  const links = new Map<number, number>();
  for (const [n, c] of [...ga.links, ...gb.links]) if (n !== a && n !== b) links.set(n, (links.get(n) ?? 0) + c);
  groups.push({ files: [...ga.files, ...gb.files], size: ga.size + gb.size, key: compareStrings(ga.key, gb.key) < 0 ? ga.key : gb.key, alive: true, links });
  for (const [n, c] of links) {
    const gn = groups[n]!;
    gn.links.delete(a);
    gn.links.delete(b);
    gn.links.set(id, c);
    pushCandidate(ctx, heap, groups, id, n, c);
  }
}

/**
 * 确定性合并聚类：每个文件一组，反复合并得分最高且合并后不超过 moduleMaxSize 的两组，相同时按路径字典序；
 * 没有组间边时停止。候选放在堆里，合并时只更新相邻组，文件多时也不会逐对重算。
 */
function clusterFiles(ctx: Ctx, files: string[]): Group[] {
  const groups = initialGroups(ctx, files);
  const heap = new CandidateHeap();
  groups.forEach((g, a) => { for (const [b, c] of g.links) if (a < b) pushCandidate(ctx, heap, groups, a, b, c); });
  for (let c = heap.pop(); c; c = heap.pop()) {
    if (groups[c.a]!.alive && groups[c.b]!.alive) mergeGroups(ctx, heap, groups, c.a, c.b);
  }
  return groups.filter((g) => g.alive).sort((x, y) => compareStrings(x.key, y.key));
}

/** 第一次划分（或某组超过记录规模 2 倍）时重新聚类，结果写进记录 */
function freshClusters(ctx: Ctx, node: DirNode): Map<string, string[]> {
  const groups = clusterFiles(ctx, node.files);
  forgetClusters(ctx, node.path);
  const out = new Map<string, string[]>();
  for (const g of groups) {
    const id = clusterId(ctx, node.path, g, out);
    out.set(id, g.files);
    ctx.rec.sizes[id] = g.size;
    for (const f of g.files) ctx.rec.clusters[f] = id;
  }
  log.info('partition_dir_clustered', { dir: node.path, groups: out.size, files: node.files.length });
  return out;
}

/** `<目录>#<组里规模最大的文件名去掉后缀>`；同名（如 a.py 和 a.pyi）时用带后缀的文件名 */
function clusterId(ctx: Ctx, dir: string, g: Group, taken: Map<string, string[]>): string {
  const largest = [...g.files].sort((a, b) => ctx.fileSize.get(b)! - ctx.fileSize.get(a)! || compareStrings(a, b))[0]!;
  const id = clusterIdPrefix(dir) + fileStem(largest);
  return taken.has(id) ? clusterIdPrefix(dir) + path.posix.basename(largest) : id;
}

/** 重新聚类前清掉这个目录旧的文件归属和组规模，避免旧 id 混进新结果 */
function forgetClusters(ctx: Ctx, dir: string): void {
  const prefix = clusterIdPrefix(dir);
  for (const [f, id] of Object.entries(ctx.rec.clusters)) if (dirOf(f) === dir || id.startsWith(prefix)) delete ctx.rec.clusters[f];
  for (const id of Object.keys(ctx.rec.sizes)) if (id.startsWith(prefix)) delete ctx.rec.sizes[id];
}

// ---------- 合并过碎 ----------

function mergeSmallModules(ctx: Ctx): void {
  for (const id of [...ctx.modules.keys()].sort(compareStrings)) {
    const m = ctx.modules.get(id);
    if (!m) continue;
    const target = mergeTarget(ctx, m);
    if (!target) continue;
    const t = ctx.modules.get(target)!;
    t.files.push(...m.files);
    t.mergedFrom.push(m.id, ...m.mergedFrom);
    ctx.modules.delete(m.id);
    ctx.mergedInto.set(m.id, target);
  }
}

/**
 * 照记录：合并目标还存在、规模不超过 2 × moduleMinSize 时照记录合并；记录为保持独立（null）且规模在记录规模的
 * 0.5–2 倍内时保持独立。否则重新决定：规模小于 moduleMinSize 时按调用边找目标，结果（含保持独立）和规模写进记录。
 */
function mergeTarget(ctx: Ctx, m: Draft): string | undefined {
  const size = sizeOf(ctx, m.files);
  const recorded = ctx.old?.merges[m.id];
  if (typeof recorded === 'string' && recorded !== m.id && ctx.modules.has(recorded) && size <= 2 * ctx.th.moduleMinSize) return recorded;
  const base = ctx.old?.mergeSizes?.[m.id];
  if (recorded === null && base !== undefined && withinRecordedRange(size, base)) return undefined;
  const target = size < ctx.th.moduleMinSize ? firstMergeTarget(ctx, m) : undefined;
  ctx.rec.merges[m.id] = target ?? null;
  (ctx.rec.mergeSizes ??= {})[m.id] = size;
  if (target || recorded !== undefined) {
    log.info('partition_merge_decided', { module: m.id, size, target: target ?? null, recorded: recorded === undefined ? undefined : recorded, recordedSize: base });
  }
  return target;
}

/** 同一父目录下 call / reference 边最多的兄弟模块，没有边时 `<父目录>/*`，都没有时保持独立 */
function firstMergeTarget(ctx: Ctx, m: Draft): string | undefined {
  if (m.scope === undefined) return undefined;
  let best: { id: string; edges: number } | undefined;
  const siblings = [...ctx.modules.values()].filter((s) => s !== m && s.scope === m.scope).sort((a, b) => compareStrings(a.id, b.id));
  for (const s of siblings) {
    const edges = edgesBetween(ctx.callGraph, m.files, new Set(s.files));
    if (edges > 0 && (!best || edges > best.edges)) best = { id: s.id, edges };
  }
  if (best) return best.id;
  const rest = m.scope === ROOT ? REST_ID : `${m.scope}/*`;
  return rest !== m.id && ctx.modules.has(rest) ? rest : undefined;
}

function resolveMerged(ctx: Ctx, id: string): string {
  for (let next = ctx.mergedInto.get(id); next !== undefined; next = ctx.mergedInto.get(id)) id = next;
  return id;
}

// ---------- 没有符号的文件 ----------

function assignEmptyFiles(ctx: Ctx, files: string[]): void {
  for (const f of files) {
    const id = resolveMerged(ctx, emptyFileModule(ctx, f));
    ctx.modules.get(id)!.files.push(f);
  }
}

/** 从文件所在目录逐级向上，找第一个覆盖该目录的模块；都没有时归入 `*` */
function emptyFileModule(ctx: Ctx, file: string): string {
  for (let dir: string | undefined = dirOf(file); dir !== undefined; dir = parentDir(dir)) {
    const id = moduleCoveringDir(ctx, dir, file);
    if (id) return id;
  }
  if (!ctx.created.has(REST_ID)) addModule(ctx, { id: REST_ID, dir: ROOT, kind: 'rest', files: [] });
  return REST_ID;
}

function moduleCoveringDir(ctx: Ctx, dir: string, file: string): string | undefined {
  const decision = ctx.decisions.get(dir);
  if (decision === 'whole') return wholeId(dir);
  if (decision !== 'split') return undefined;
  const node = ctx.tree.get(dir)!;
  if (ctx.created.has(directId(node))) return directId(node);
  const clusters = new Map([...ctx.created.values()].filter((m) => m.kind === 'cluster' && m.dir === dir).map((m) => [m.id, m.files]));
  if (clusters.size === 0) return undefined;
  const recorded = ctx.old?.clusters[file];
  const id = recorded && clusters.has(recorded) ? recorded : pickGroup(ctx, ctx.linkGraph, file, clusters, 'largest');
  ctx.rec.clusters[file] = id;
  return id;
}

// ---------- 入口 ----------

function buildIndex(modules: PartitionModule[], symbols: SymbolRow[]): ModuleIndex {
  const byPath = new Map<string, string>();
  for (const m of modules) for (const f of m.files) byPath.set(f, m.id);
  const bySymbol = new Map<string, string>();
  for (const s of symbols) {
    const id = byPath.get(s.path);
    if (id !== undefined) bySymbol.set(s.id, id);
  }
  return { byPath, bySymbol };
}

function finishModules(ctx: Ctx): PartitionModule[] {
  return [...ctx.modules.values()]
    .map((d) => ({ id: d.id, dir: d.dir, kind: d.kind, files: [...d.files].sort(compareStrings), size: sizeOf(ctx, d.files), mergedFrom: [...d.mergedFrom].sort(compareStrings) }))
    .sort((a, b) => compareStrings(a.id, b.id));
}

function createContext(input: PartitionInput, files: string[]): { ctx: Ctx; warnings: Warning[] } {
  const { record: old, warnings } = applicableRecord(input.record, input.thresholds);
  const fileSize = fileSizes(files, input.symbols);
  const graphs = fileGraphs(input.symbols, input.edges, new Set(files));
  const ctx: Ctx = {
    th: input.thresholds, old, rec: startRecord(old, input.thresholds), fileSize, tree: buildTree(fileSize), ...graphs,
    decisions: new Map(), modules: new Map(), created: new Map(), mergedInto: new Map(),
  };
  return { ctx, warnings };
}

/**
 * 模块划分（概览第 1 步）。只有第一次决定会看调用边；之后已有文件的归属照记录，调用边怎么变都不变。
 * 输入相同（快照和记录）时结果相同。
 */
export function partition(input: PartitionInput): PartitionResult {
  const included = input.files.filter(participates);
  const files = included.map((f) => f.path).sort(compareStrings);
  const { ctx, warnings } = createContext(input, files);
  if (ctx.tree.get(ROOT)!.size > 0) visitDir(ctx, ROOT);
  mergeSmallModules(ctx);
  assignEmptyFiles(ctx, files.filter((f) => ctx.fileSize.get(f) === 0));
  const modules = finishModules(ctx);
  const recordChanged = !sameDecisions(input.record, ctx.rec);
  const record = recordChanged ? { ...ctx.rec, updatedAt: input.now ?? Date.now(), ...(input.source ? { source: input.source } : {}) } : ctx.rec;
  const stats: PartitionStats = {
    files: files.length,
    emptyFiles: files.filter((f) => ctx.fileSize.get(f) === 0).length,
    testFiles: input.files.filter((f) => f.isTest && f.supportLevel !== 'none').length,
  };
  log.info('partition_done', { modules: modules.length, ...stats, reset: warnings.length > 0, recordChanged });
  return { modules, index: buildIndex(modules, input.symbols), record, recordChanged, stats, warnings };
}

/** 从快照读划分需要的文件、符号和边 */
export function loadPartitionInput(store: Store, snapshotId: number): Pick<PartitionInput, 'files' | 'symbols' | 'edges'> {
  return { files: store.getFiles(snapshotId), symbols: store.getSymbols(snapshotId, { withTokens: false }), edges: store.getEdges(snapshotId) };
}
