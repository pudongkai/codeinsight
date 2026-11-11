import type { EdgeKind, EdgeRow } from '../model/types.js';
import type { ExtractedFile, ExtractedSymbol } from '../extract/types.js';
import { SCIP_ROLE_DEFINITION, type ScipDocument, type ScipIndex, type ScipOccurrence, type ScipRange } from '../scip/reader.js';
import { continuedLines } from './python-lines.js';
import type { ResolveResult } from './types.js';

/** 提取层与 SCIP 定义对不上的比例超过这个值时给出 warning */
const UNMATCHED_WARN_RATIO = 0.01;

interface FileTable {
  file: ExtractedFile;
  module: ExtractedSymbol;
  /** `行:列` → 名字标识符在该位置的符号 */
  byNamePos: Map<string, ExtractedSymbol>;
  byName: Map<string, ExtractedSymbol[]>;
  /** 非 module 符号，用于查找包含某一行的最内层定义 */
  defs: ExtractedSymbol[];
  lines: string[];
  /** 该行的逻辑行是否延续到下一行 */
  continued: boolean[];
}

function posKey(line: number, col: number): string {
  return `${line}:${col}`;
}

function buildTable(file: ExtractedFile, source: string): FileTable {
  const byNamePos = new Map<string, ExtractedSymbol>();
  const byName = new Map<string, ExtractedSymbol[]>();
  const defs: ExtractedSymbol[] = [];
  for (const s of file.symbols) {
    if (s.kind === 'module') continue;
    byNamePos.set(posKey(s.nameLine, s.nameCol), s);
    byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
    defs.push(s);
  }
  return { file, module: file.symbols[0]!, byNamePos, byName, defs, lines: source.split('\n'), continued: continuedLines(source) };
}

function occurrenceText(lines: string[], r: ScipRange): string {
  return r.startLine === r.endLine ? (lines[r.startLine] ?? '').slice(r.startChar, r.endChar) : '';
}

/** 定义对应到提取层符号：优先按名字位置；否则按同名、起始行落在 enclosing_range 内 */
function matchDefinition(t: FileTable, occ: ScipOccurrence, enc: ScipRange): ExtractedSymbol | undefined {
  const exact = t.byNamePos.get(posKey(occ.range.startLine, occ.range.startChar));
  if (exact) return exact;
  const name = occurrenceText(t.lines, occ.range);
  const inRange = (t.byName.get(name) ?? []).filter((s) => s.startLine - 1 >= enc.startLine && s.startLine - 1 <= enc.endLine);
  inRange.sort((a, b) => Math.abs(a.startLine - 1 - enc.startLine) - Math.abs(b.startLine - 1 - enc.startLine));
  return inRange[0];
}

/**
 * 同一作用域里同名的多个定义（重复定义、if/else 两个分支各定义一次）对应同一个 SCIP 符号，
 * 模块加载完后名字绑定的是最后一个，引用连到最后一个定义
 */
function lastBinding(t: FileTable, sym: ExtractedSymbol): ExtractedSymbol {
  let last = sym;
  for (const s of t.byName.get(sym.name) ?? []) {
    if (s.parentId === sym.parentId && s.kind === sym.kind && s.startLine > last.startLine) last = s;
  }
  return last;
}

interface DefinitionMap {
  scipToId: Map<string, string>;
  total: number;
  unmatched: number;
}

function isModuleDefinition(occ: ScipOccurrence): boolean {
  return occ.symbol.endsWith('/__init__:') && occ.range.startLine === 0 && occ.range.startChar === 0;
}

/** SCIP 符号 → 提取层符号 id。只收录本快照文件里的定义，其他符号（外部库、局部变量）没有对应项 */
function mapDefinitions(docs: [ScipDocument, FileTable][]): DefinitionMap {
  const map: DefinitionMap = { scipToId: new Map(), total: 0, unmatched: 0 };
  for (const [doc, t] of docs) {
    for (const occ of doc.occurrences) {
      if (!(occ.roles & SCIP_ROLE_DEFINITION)) continue;
      if (isModuleDefinition(occ)) {
        map.scipToId.set(occ.symbol, t.module.id);
        continue;
      }
      if (!occ.enclosingRange) continue;
      map.total++;
      const sym = matchDefinition(t, occ, occ.enclosingRange);
      if (sym) map.scipToId.set(occ.symbol, lastBinding(t, sym).id);
      else map.unmatched++;
    }
  }
  return map;
}

/** 包含该行的最内层定义；不在任何定义里时归属 module 符号 */
function innermost(t: FileTable, row: number): ExtractedSymbol {
  let best: ExtractedSymbol | undefined;
  for (const s of t.defs) {
    if (row < s.startLine - 1 || row > s.endLine - 1) continue;
    if (!best || s.startLine > best.startLine || (s.startLine === best.startLine && s.endLine < best.endLine)) best = s;
  }
  return best ?? t.module;
}

/** 同一条语句内，引用位置后面第一个非空白字符是 `(` 时为调用；语句在行尾结束就停止 */
function isCallAt(t: FileTable, r: ScipRange): boolean {
  for (let row = r.endLine; row < t.lines.length; row++) {
    const line = t.lines[row]!;
    const rest = (row === r.endLine ? line.slice(r.endChar) : line).trim();
    if (rest.length > 0 && rest[0] !== '#' && rest !== '\\') return rest[0] === '(';
    if (!t.continued[row]) return false;
  }
  return false;
}

function inImport(t: FileTable, row: number): boolean {
  return t.file.importRows.some(([a, b]) => row >= a && row <= b);
}

function referenceEdge(t: FileTable, occ: ScipOccurrence, dstId: string, snapshotId: number): EdgeRow | undefined {
  const row = occ.range.startLine;
  let kind: EdgeKind;
  let srcId: string;
  if (inImport(t, row)) {
    kind = 'import';
    srcId = t.module.id;
  } else {
    kind = isCallAt(t, occ.range) ? 'call' : 'reference';
    srcId = innermost(t, row).id;
  }
  // 自己引用自己的边丢弃，递归调用保留
  if (srcId === dstId && kind !== 'call') return undefined;
  return {
    snapshotId, srcId, dstId, kind, provenance: 'scip', confidence: 'high',
    path: t.file.path, line: row + 1, col: occ.range.startChar,
  };
}

function documentEdges(doc: ScipDocument, t: FileTable, defs: DefinitionMap, snapshotId: number): EdgeRow[] {
  const edges: EdgeRow[] = [];
  for (const occ of doc.occurrences) {
    if (occ.roles & SCIP_ROLE_DEFINITION) continue;
    // 重复定义的同名函数，scip-python 把后一个的名字记成引用，按定义处理
    if (t.byNamePos.has(posKey(occ.range.startLine, occ.range.startChar))) continue;
    const dstId = defs.scipToId.get(occ.symbol);
    if (!dstId) continue;
    const edge = referenceEdge(t, occ, dstId, snapshotId);
    if (edge) edges.push(edge);
  }
  return edges;
}

/**
 * SCIP → 边：不在文件清单里的 document 丢弃；src 为引用所在的最内层定义（顶层代码归属 module 符号），
 * dst 必须是本快照内定义的符号，外部符号丢弃。
 */
export function scipToEdges(
  index: ScipIndex,
  files: ExtractedFile[],
  sources: Map<string, string>,
  snapshotId: number,
): ResolveResult {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const docs: [ScipDocument, FileTable][] = [];
  for (const doc of index.documents) {
    const file = byPath.get(doc.relativePath);
    if (file) docs.push([doc, buildTable(file, sources.get(file.path) ?? '')]);
  }
  const defs = mapDefinitions(docs);
  const edges = docs.flatMap(([doc, t]) => documentEdges(doc, t, defs, snapshotId));
  const ratio = defs.total > 0 ? defs.unmatched / defs.total : 0;
  const note = ratio > UNMATCHED_WARN_RATIO
    ? `${(ratio * 100).toFixed(1)}% scip definitions unmatched (${defs.unmatched} of ${defs.total})`
    : undefined;
  return { edges, note };
}
