import type { ReviewReport, SymbolChange, SymbolRef } from '@codeinsight/core/report/types';
import type { GraphEdgeSpec, GraphNodeSpec, NodeTone } from '../graph/types';
import { location } from '../format';
import { symbolMarks } from '../marks/marks';
import type { SymbolTarget } from './actions';

/** 结构图里最多画这么多个改动函数（按正式代码调用方数从多到少） */
export const MAX_GRAPH_CHANGES = 60;

export interface ReportGraph {
  nodes: GraphNodeSpec[];
  edges: GraphEdgeSpec[];
  /** 节点 id → 点击时的目标 */
  targets: Map<string, { change?: SymbolChange; target: SymbolTarget }>;
  /** 没画出来的改动函数个数 */
  omitted: number;
  /** 因"显示模型"关闭而没画的模型类个数 */
  hiddenModels: number;
}

const TONES: Record<SymbolChange['change'], NodeTone> = {
  added: 'added', removed: 'removed', modified: 'modified', signature_changed: 'modified', moved: 'moved',
};

const nodeId = (key: string) => `k:${key}`;

/** 函数或调用边所在的版本：被删除的只在 base 里，其余在 head */
export function sideOf(c: { change: string }): 'base' | 'head' {
  return c.change === 'removed' ? 'base' : 'head';
}

export function changeTarget(c: SymbolChange): SymbolTarget {
  const side = sideOf(c);
  return { side, id: c.id, name: c.qualifiedName, path: c.path, startLine: c.startLine, removed: side === 'base' };
}

export function refTarget(r: SymbolRef, side: 'base' | 'head'): SymbolTarget {
  return { side, id: r.id, name: r.qualifiedName, path: r.path, startLine: r.startLine, removed: side === 'base' };
}

function selectChanges(report: ReviewReport): { shown: SymbolChange[]; omitted: number } {
  const all = report.modules.flatMap((m) => m.symbols).filter((s) => s.kind !== 'module');
  const sorted = [...all].sort((a, b) => b.callers.prod - a.callers.prod || a.path.localeCompare(b.path) || a.startLine - b.startLine);
  return { shown: sorted.slice(0, MAX_GRAPH_CHANGES), omitted: Math.max(0, sorted.length - MAX_GRAPH_CHANGES) };
}

/**
 * 报告里的结构图：改动函数，加上它们的正式代码调用方（topProd，每个改动最多 5 个）和调用边变化的另一端。
 * 新增边绿色、删除边红色虚线，其余调用关系灰色。只用报告数据，离线 HTML 报告也能画。
 * showModels 为 false 时不画模型类（改动的和相邻的都不画），连到它们的边也不画。
 */
export function buildReportGraph(report: ReviewReport, opts: { showModels?: boolean } = {}): ReportGraph {
  const showModels = opts.showModels ?? true;
  const hidden = new Set<string>();
  const { shown: selected, omitted } = selectChanges(report);
  const shown = selected.filter((c) => {
    if (showModels || !c.modelKind) return true;
    hidden.add(c.key);
    return false;
  });
  const nodes = new Map<string, GraphNodeSpec>();
  const edges = new Map<string, GraphEdgeSpec>();
  const targets: ReportGraph['targets'] = new Map();
  for (const c of shown) {
    const id = nodeId(c.key);
    nodes.set(id, { id, label: c.name, sublabel: location(c.path, c.startLine), tone: TONES[c.change], title: c.qualifiedName, attrs: { change: c.change }, marks: symbolMarks(c) });
    targets.set(id, { change: c, target: changeTarget(c) });
  }
  const addRef = (r: SymbolRef, side: 'base' | 'head'): string | undefined => {
    const id = nodeId(r.key);
    if (nodes.has(id)) return id;
    if (!showModels && r.modelKind) {
      hidden.add(r.key);
      return undefined;
    }
    nodes.set(id, { id, label: r.name, sublabel: location(r.path, r.startLine), tone: r.isTest ? 'test' : 'neighbor', title: r.qualifiedName, marks: symbolMarks(r) });
    targets.set(id, { target: refTarget(r, side) });
    return id;
  };
  const addEdge = (src: string | undefined, dst: string | undefined, tone: GraphEdgeSpec['tone']) => {
    if (!src || !dst) return;
    const id = `${tone}:${src}->${dst}`;
    if (!edges.has(id)) edges.set(id, { id, source: src, target: dst, tone });
  };
  for (const c of shown) for (const caller of c.callers.topProd) addEdge(addRef(caller, sideOf(c)), nodeId(c.key), 'normal');
  const shownKeys = new Set(shown.map((c) => c.key));
  for (const e of report.edgeChanges) {
    if (!shownKeys.has(e.src.key) && !shownKeys.has(e.dst.key)) continue;
    addEdge(addRef(e.src, sideOf(e)), addRef(e.dst, sideOf(e)), e.change);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], targets, omitted, hiddenModels: hidden.size };
}
