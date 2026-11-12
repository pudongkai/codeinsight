import path from 'node:path';
import { log } from '../log.js';
import type { EdgeRow } from '../model/types.js';
import type { Warning } from '../report/types.js';
import { pushTo } from '../util/collections.js';
import { fileStem } from '../util/paths.js';
import { isHttpHandler, moduleOfSymbol, sampleOf, type OverviewGraph } from './facts.js';
import type { BoundaryIssue, Layer, ModuleEdge } from './types.js';
import { compareStrings } from '../util/compare.js';

/** 层次从高到低 */
export const LAYERS: readonly Layer[] = ['entry', 'service', 'data', 'common'];

/** 各层对应的文件名（去后缀）或目录名，不区分大小写；可在 `overview.layers` 里按层覆盖 */
export type LayerNames = Record<Layer, string[]>;

/** 不把 `core` 当作 common：很多项目的 core 是业务核心 */
export const DEFAULT_LAYER_NAMES: LayerNames = {
  entry: ['api', 'views', 'routes', 'router', 'endpoints', 'controllers', 'handlers'],
  service: ['service', 'services', 'logic', 'domain', 'usecase', 'usecases'],
  data: ['repository', 'repositories', 'repo', 'dao', 'crud', 'db', 'models', 'schemas'],
  common: ['common', 'utils', 'util', 'lib', 'shared'],
};

const MAX_ISSUE_SAMPLES = 10;
/** 让文件进入 entry 层的入口类型（中间件不算） */
const ENTRY_KINDS = new Set(['cli', 'task', 'schedule']);

/** 文件名等于某个名字或以 `_<名字>` 结尾（如 `admin_api`）；common 只看所在目录 */
function nameLayer(file: string, names: LayerNames): Layer | undefined {
  const stem = fileStem(file).toLowerCase();
  const dirs = path.posix.dirname(file).split('/').map((d) => d.toLowerCase());
  for (const layer of LAYERS) {
    const list = names[layer].map((n) => n.toLowerCase());
    if (layer !== 'common' && list.some((n) => stem === n || stem.endsWith(`_${n}`))) return layer;
    if (list.some((n) => dirs.includes(n))) return layer;
  }
  return undefined;
}

/** 每个模块文件所在的层；一个文件对上多个层时按 entry > service > data > common 取第一个，没对上的不定层 */
export function fileLayers(g: OverviewGraph, names: LayerNames): Map<string, Layer> {
  const entryFiles = new Set<string>();
  for (const [id, e] of g.entries) {
    if (isHttpHandler(g, id) || ENTRY_KINDS.has(e.kind)) entryFiles.add(g.symbols.get(id)!.path);
  }
  const out = new Map<string, Layer>();
  for (const file of g.index.byPath.keys()) {
    const layer = entryFiles.has(file) ? 'entry' : nameLayer(file, names);
    if (layer) out.set(file, layer);
  }
  return out;
}

export function moduleLayers(files: string[], layers: Map<string, Layer>): Partial<Record<Layer, string[]>> {
  const out: Partial<Record<Layer, string[]>> = {};
  for (const f of [...files].sort()) {
    const l = layers.get(f);
    if (l) (out[l] ??= []).push(f);
  }
  return out;
}

// ---------- 循环依赖 ----------

/** Tarjan 求强连通分量，按模块 id 排序遍历；只返回节点数 ≥ 2 的分量 */
export function stronglyConnected(nodes: string[], edges: ModuleEdge[]): string[][] {
  const next = new Map<string, string[]>();
  for (const e of edges) if (e.weight > 0) pushTo(next, e.from, e.to);
  for (const list of next.values()) list.sort();
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  const visit = (v: string): void => {
    idx.set(v, idx.size);
    low.set(v, idx.get(v)!);
    stack.push(v);
    onStack.add(v);
    for (const w of next.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) !== idx.get(v)) return;
    const comp: string[] = [];
    for (let w = stack.pop()!; ; w = stack.pop()!) {
      onStack.delete(w);
      comp.push(w);
      if (w === v) break;
    }
    if (comp.length >= 2) out.push(comp.sort());
  };
  for (const v of [...nodes].sort()) if (!idx.has(v)) visit(v);
  return out.sort((a, b) => compareStrings(a[0]!, b[0]!));
}

/** 循环依赖：每个分量一条 warning，分量内的边标 inCycle */
function cycleIssues(g: OverviewGraph, edges: ModuleEdge[]): BoundaryIssue[] {
  const comps = stronglyConnected(g.modules.map((m) => m.id), edges);
  return comps.map((comp) => {
    const members = new Set(comp);
    const inside = edges.filter((e) => e.weight > 0 && members.has(e.from) && members.has(e.to));
    for (const e of inside) e.inCycle = true;
    return {
      kind: 'cycle', severity: 'warning', modules: comp,
      message: `模块之间循环依赖：${comp.join('、')}`,
      samples: inside.flatMap((e) => e.samples).slice(0, MAX_ISSUE_SAMPLES),
    };
  });
}

// ---------- 按边逐条检查的问题 ----------

interface Finding {
  kind: Exclude<BoundaryIssue['kind'], 'cycle'>;
  /** 聚合的 key：同一 key 的边合成一条问题 */
  group: string;
  modules: string[];
  message: (count: number) => string;
}

const rank = (l: Layer) => LAYERS.indexOf(l);
const isPrivateName = (name: string) => /^_[^_]/.test(name) || name === '_';

interface EdgeContext {
  g: OverviewGraph;
  layers: Map<string, Layer>;
  /** 有 service 层文件的模块 */
  withService: Set<string>;
}

function layerFindings(ctx: EdgeContext, e: EdgeRow, from: string, to: string): Finding[] {
  const src = ctx.g.symbols.get(e.srcId)!;
  const dst = ctx.g.symbols.get(e.dstId)!;
  const [sl, dl] = [ctx.layers.get(src.path), ctx.layers.get(dst.path)];
  if (!sl || !dl || dst.modelKind) return [];
  const out: Finding[] = [];
  if (rank(sl) > rank(dl)) {
    out.push({ kind: 'layer_violation', group: `${from}\0${to}\0${sl}\0${dl}`, modules: [...new Set([from, to])], message: (n) => `${sl} 层调用了 ${dl} 层（${from} → ${to}，${n} 处）` });
  }
  if (sl === 'entry' && dl === 'data' && (dst.kind === 'function' || dst.kind === 'method') && ctx.withService.has(from)) {
    out.push({ kind: 'layer_skip', group: `${from}\0${to}`, modules: [...new Set([from, to])], message: (n) => `entry 层直接调用 data 层，跳过了 service 层（${from} → ${to}，${n} 处）` });
  }
  return out;
}

/** 指向 module 符号的引用（`from pkg import mod` 后的 `mod.f`）不单独算，同一处调用另有指向函数的边 */
function edgeFindings(ctx: EdgeContext, e: EdgeRow): Finding[] {
  if (ctx.g.symbols.get(e.srcId)!.kind === 'module' || ctx.g.symbols.get(e.dstId)!.kind === 'module') return [];
  const from = moduleOfSymbol(ctx.g, e.srcId)!;
  const to = moduleOfSymbol(ctx.g, e.dstId)!;
  const out = layerFindings(ctx, e, from, to);
  if (from !== to && isPrivateName(ctx.g.symbols.get(e.dstId)!.name)) {
    out.push({ kind: 'private_access', group: `${from}\0${to}`, modules: [from, to], message: (n) => `${from} 访问了 ${to} 的私有函数（${n} 处）` });
  }
  return out;
}

const SEVERITY: Record<Finding['kind'], BoundaryIssue['severity']> = { layer_violation: 'warning', layer_skip: 'info', private_access: 'info' };

function edgeIssues(ctx: EdgeContext): BoundaryIssue[] {
  const groups = new Map<string, { f: Finding; edges: EdgeRow[] }>();
  for (const e of ctx.g.links) {
    for (const f of edgeFindings(ctx, e)) {
      const key = `${f.kind}\0${f.group}`;
      const cur = groups.get(key);
      if (cur) cur.edges.push(e);
      else groups.set(key, { f, edges: [e] });
    }
  }
  return [...groups.values()].map(({ f, edges }) => ({
    kind: f.kind, severity: SEVERITY[f.kind], modules: f.modules, message: f.message(edges.length),
    samples: edges.slice(0, MAX_ISSUE_SAMPLES).map((e) => sampleOf(ctx.g, e)),
  }));
}

const KIND_ORDER: BoundaryIssue['kind'][] = ['cycle', 'layer_violation', 'layer_skip', 'private_access'];

export interface BoundaryResult {
  issues: BoundaryIssue[];
  layers: Map<string, Layer>;
  warnings: Warning[];
}

/**
 * 边界问题（第 4–6 步）：循环依赖、跨层调用、跳过业务层、跨模块访问私有函数。
 * 只看 call / reference 边；会修改 edges 的 inCycle。一个层都没对上时跳过分层检查并给 `layers_not_detected`。
 */
export function boundaryIssues(g: OverviewGraph, edges: ModuleEdge[], names: LayerNames): BoundaryResult {
  const layers = fileLayers(g, names);
  const warnings: Warning[] = [];
  if (layers.size === 0) {
    log.info('overview_layers_not_detected', { files: g.index.byPath.size });
    warnings.push({ code: 'layers_not_detected', level: 'info', message: 'no file matched the layer conventions (overview.layers); layer checks were skipped' });
  }
  const withService = new Set([...layers].filter(([, l]) => l === 'service').map(([f]) => g.index.byPath.get(f)!));
  const issues = [...cycleIssues(g, edges), ...edgeIssues({ g, layers, withService })]
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || compareStrings(a.modules.join(), b.modules.join()) || compareStrings(a.message, b.message));
  log.info('overview_boundary_done', Object.fromEntries(KIND_ORDER.map((k) => [k, issues.filter((i) => i.kind === k).length])));
  return { issues, layers, warnings };
}
