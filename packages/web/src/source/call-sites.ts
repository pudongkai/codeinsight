import type { SymbolInfo, TreeResponse } from '../api/types';

export interface CallSite {
  line: number;
  /** 从 0 开始 */
  col: number;
  target: SymbolInfo;
}

export type Segment = { text: string; site?: CallSite };

/** 函数自身发出的、落在函数范围内的项目内调用和引用（不含 import） */
export function callSites(tree: TreeResponse, symbol: SymbolInfo): CallSite[] {
  const nodes = new Map(tree.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const out: CallSite[] = [];
  for (const e of tree.edges) {
    const target = nodes.get(e.dstId);
    if (e.srcId !== symbol.id || !target || e.kind === 'import' || e.path !== symbol.path) continue;
    if (e.line < symbol.startLine || e.line > symbol.endLine) continue;
    const k = `${e.line}:${e.col}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ line: e.line, col: e.col, target });
  }
  return out.sort((a, b) => a.line - b.line || a.col - b.col);
}

const IDENT = /^[\p{L}_][\p{L}\p{N}_]*/u;

/** 把一行源码切成普通文本和调用点（调用点覆盖从 col 开始的标识符） */
export function splitLine(text: string, sites: CallSite[]): Segment[] {
  const segs: Segment[] = [];
  let pos = 0;
  for (const site of [...sites].sort((a, b) => a.col - b.col)) {
    if (site.col < pos || site.col >= text.length) continue;
    const len = IDENT.exec(text.slice(site.col))?.[0].length ?? 1;
    if (site.col > pos) segs.push({ text: text.slice(pos, site.col) });
    segs.push({ text: text.slice(site.col, site.col + len), site });
    pos = site.col + len;
  }
  if (pos < text.length || segs.length === 0) segs.push({ text: text.slice(pos) });
  return segs;
}
