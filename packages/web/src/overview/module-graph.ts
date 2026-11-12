import type { BoundaryIssue, ModuleEdge, OverviewModule, OverviewReport } from '@codeinsight/core/overview/types';
import type { EdgeTone, GraphEdgeSpec, GraphNodeSpec } from '../graph/types';
import { CATEGORY_LABELS } from './labels';

/** 模块多于这么多个时，默认只画有边界问题的模块和权重最大的这么多条边 */
export const MAX_GRAPH_MODULES = 80;

/** 节点上最多显示几个外部依赖类别 */
const MAX_NODE_TAGS = 3;

export const edgeId = (e: Pick<ModuleEdge, 'from' | 'to'>) => `${e.from}->${e.to}`;

/** 每个模块涉及的边界问题数 */
export function issueCounts(issues: BoundaryIssue[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const i of issues) for (const m of new Set(i.modules)) out.set(m, (out.get(m) ?? 0) + 1);
  return out;
}

/** 跨层调用（含跳过业务层）发生在两个不同模块之间时，对应的模块边 id */
function layerEdgeIds(issues: BoundaryIssue[]): Set<string> {
  const out = new Set<string>();
  for (const i of issues) {
    if ((i.kind === 'layer_violation' || i.kind === 'layer_skip') && i.modules.length === 2) out.add(edgeId({ from: i.modules[0]!, to: i.modules[1]! }));
  }
  return out;
}

/** 循环依赖的边红色，有跨层调用的边橙色，其余灰色 */
export function edgeTone(e: ModuleEdge, layerEdges: Set<string>): EdgeTone {
  if (e.inCycle) return 'cycle';
  return layerEdges.has(edgeId(e)) ? 'layer' : 'normal';
}

/** 线宽按 weight 的对数增长；只有 import 的边（weight 0）最细 */
export function edgeWidth(weight: number): number {
  return Math.min(6, 1 + Math.log2(weight + 1));
}

function nodeTags(m: OverviewModule): GraphNodeSpec['tags'] {
  const cats = m.external.filter((x) => x.category !== 'other');
  const tags = cats.slice(0, MAX_NODE_TAGS).map((x) => ({ label: CATEGORY_LABELS[x.category].short, title: `${CATEGORY_LABELS[x.category].label}：${x.libs.join('、')}` }));
  const rest = cats.slice(MAX_NODE_TAGS);
  if (rest.length > 0) tags.push({ label: `+${rest.length}`, title: rest.map((x) => CATEGORY_LABELS[x.category].label).join('、') });
  return tags;
}

function nodeSpec(m: OverviewModule, issues: number, selected: boolean): GraphNodeSpec {
  return {
    id: m.id, label: m.name, sublabel: `${m.id} · 规模 ${m.size}`,
    title: [m.name, m.id, m.responsibility, issues > 0 ? `${issues} 个边界问题` : undefined].filter(Boolean).join('\n'),
    tone: selected ? 'center' : 'neighbor',
    badge: issues > 0 ? `${issues} 问题` : undefined,
    attrs: { module: m.id, issues: String(issues) },
    tags: nodeTags(m),
  };
}

/** 模块多时要画的模块和边：有边界问题的模块，加上权重最大的边及其两端 */
function pickLarge(report: OverviewReport, counts: Map<string, number>): { modules: Set<string>; edges: ModuleEdge[] } {
  const edges = [...report.moduleEdges].sort((a, b) => b.weight - a.weight).slice(0, MAX_GRAPH_MODULES);
  const modules = new Set(report.modules.filter((m) => (counts.get(m.id) ?? 0) > 0).map((m) => m.id));
  for (const e of edges) modules.add(e.from).add(e.to);
  return { modules, edges };
}

export interface ModuleGraphView {
  nodes: GraphNodeSpec[];
  edges: GraphEdgeSpec[];
  /** 没画出来的模块数（只在模块过多且没选“显示全部”时大于 0） */
  hiddenModules: number;
}

/** 模块依赖图：节点为模块，边为模块间依赖 */
export function buildModuleGraph(report: OverviewReport, opts: { showAll: boolean; selected?: string }): ModuleGraphView {
  const counts = issueCounts(report.issues);
  const large = !opts.showAll && report.modules.length > MAX_GRAPH_MODULES ? pickLarge(report, counts) : undefined;
  const modules = large ? report.modules.filter((m) => large.modules.has(m.id)) : report.modules;
  const layerEdges = layerEdgeIds(report.issues);
  const edges = (large?.edges ?? report.moduleEdges).filter((e) => e.from !== e.to).map((e): GraphEdgeSpec => ({
    id: edgeId(e), source: e.from, target: e.to, tone: edgeTone(e, layerEdges), width: edgeWidth(e.weight),
    attrs: { from: e.from, to: e.to, weight: String(e.weight) },
  }));
  return {
    nodes: modules.map((m) => nodeSpec(m, counts.get(m.id) ?? 0, m.id === opts.selected)),
    edges,
    hiddenModules: report.modules.length - modules.length,
  };
}
