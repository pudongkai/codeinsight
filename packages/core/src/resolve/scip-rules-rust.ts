import type { RustPackage } from '../extract/rust-cargo.js';
import type { ExtractedFile } from '../extract/types.js';
import { SCIP_ROLE_DEFINITION, type ScipDocument, type ScipIndex, type ScipOccurrence } from '../scip/reader.js';
import type { ScipLanguageRules } from './scip-rules.js';

/** 重复符号按 crate 目标区分时加在符号后面的分隔符（SCIP 符号里不会出现） */
const TARGET_SEP = ' @';

type ScanMode = { kind: 'code' } | { kind: 'block'; depth: number } | { kind: 'str' } | { kind: 'raw'; hashes: number };

const IDENT_CHAR = /[A-Za-z0-9_]/;
/** 原始字符串的开头：`r"`、`r#"`、`br"`、`cr"` */
const RAW_START = /^(?:b|c)?r(#*)"/;

/** 普通字符串里从 i 开始找结束引号（处理转义）；找不到时返回 -1 */
function stringEnd(line: string, i: number): number {
  while (i < line.length) {
    if (line[i] === '\\') i += 2;
    else if (line[i] === '"') return i + 1;
    else i++;
  }
  return -1;
}

/** `'` 开头的是字符字面量（`'a'`、`'\n'`、`'\u{1F600}'`）时返回结束位置，是生命周期（`'a`）时返回 -1 */
function charLiteralEnd(line: string, i: number): number {
  if (line[i + 1] === '\\') {
    const close = line.indexOf("'", i + 3);
    return close < 0 ? -1 : close + 1;
  }
  const cp = line.codePointAt(i + 1);
  if (cp === undefined) return -1;
  const width = cp > 0xffff ? 2 : 1;
  return line[i + 1 + width] === "'" ? i + 2 + width : -1;
}

interface ScanState {
  mode: ScanMode;
  depth: number;
}

/** 在字符串、原始字符串或块注释里时，返回本行这段结束后的位置（仍没结束时为行长） */
function skipInside(line: string, i: number, st: ScanState): number {
  const m = st.mode;
  if (m.kind === 'str') {
    const end = stringEnd(line, i);
    if (end < 0) return line.length;
    st.mode = { kind: 'code' };
    return end;
  }
  if (m.kind === 'raw') {
    const close = line.indexOf(`"${'#'.repeat(m.hashes)}`, i);
    if (close < 0) return line.length;
    st.mode = { kind: 'code' };
    return close + 1 + m.hashes;
  }
  if (m.kind === 'block') {
    const open = line.indexOf('/*', i);
    const close = line.indexOf('*/', i);
    if (close < 0 && open < 0) return line.length;
    if (open >= 0 && (close < 0 || open < close)) {
      m.depth++;
      return open + 2;
    }
    if (--m.depth === 0) st.mode = { kind: 'code' };
    return close + 2;
  }
  return i;
}

/** 代码里的一个位置：进入字符串/注释，或计算括号深度；返回下一个位置，行注释时返回行长 */
function scanCode(line: string, i: number, st: ScanState): number {
  const ch = line[i]!;
  if (line.startsWith('//', i)) return line.length;
  if (line.startsWith('/*', i)) {
    st.mode = { kind: 'block', depth: 1 };
    return i + 2;
  }
  if ((ch === 'r' || ch === 'b' || ch === 'c') && (i === 0 || !IDENT_CHAR.test(line[i - 1]!))) {
    const raw = RAW_START.exec(line.slice(i));
    if (raw) {
      st.mode = { kind: 'raw', hashes: raw[1]!.length };
      return i + raw[0].length;
    }
  }
  if (ch === '"') {
    st.mode = { kind: 'str' };
    return i + 1;
  }
  if (ch === "'") {
    const end = charLiteralEnd(line, i);
    return end < 0 ? i + 1 : end;
  }
  if ('([{'.includes(ch)) st.depth++;
  else if (')]}'.includes(ch)) st.depth = Math.max(0, st.depth - 1);
  return i + 1;
}

/**
 * 按括号配对计算每行结束时语句是否延续到下一行：跳过普通字符串（可跨行、含转义）、原始字符串、字符字面量、
 * 行注释和可嵌套的块注释；`'a` 这样后面没有配对引号的是生命周期
 */
export function rustContinuedLines(source: string): boolean[] {
  const out: boolean[] = [];
  const st: ScanState = { mode: { kind: 'code' }, depth: 0 };
  for (const line of source.split('\n')) {
    let i = 0;
    while (i < line.length) i = st.mode.kind === 'code' ? scanCode(line, i, st) : skipInside(line, i, st);
    out.push(st.depth > 0 || st.mode.kind !== 'code');
  }
  return out;
}

/** 去掉开头的 turbofish `::<...>`（尖括号配对，`->` 不算），返回剩下的文字 */
export function rustCallRest(rest: string): string {
  if (!rest.startsWith('::<')) return rest;
  let depth = 0;
  for (let i = 2; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '<') depth++;
    else if (ch === '>' && rest[i - 1] !== '-' && --depth === 0) return rest.slice(i + 1).trimStart();
  }
  return rest;
}

function baseSymbol(symbol: string): string {
  const at = symbol.indexOf(TARGET_SEP);
  return at < 0 ? symbol : symbol.slice(0, at);
}

/** 文件级模块（crate 根和 `mod` 文件）的定义：在第 0 行第 0 列、以 `/` 结尾 */
function isFileModuleDefinition(occ: ScipOccurrence): boolean {
  return occ.range.startLine === 0 && occ.range.startChar === 0 && baseSymbol(occ.symbol).endsWith('/');
}

export const rustRules: ScipLanguageRules = {
  continuedLines: rustContinuedLines,
  skipsRest: (rest) => rest.startsWith('//') || rest.startsWith('/*'),
  isModuleDefinition: isFileModuleDefinition,
  callRest: rustCallRest,
};

/** 预处理后的定义统计：参与对应的定义数、其中名字位置和提取层符号直接对上的个数 */
export interface RustDefinitionStats {
  definitions: number;
  matchedByPosition: number;
}

interface FileInfo {
  file: ExtractedFile;
  target: string;
  lines: string[];
  leaves: Set<string>;
  modDecls: Set<number>;
}

function posKey(line: number, col: number): string {
  return `${line}:${col}`;
}

function fileInfo(file: ExtractedFile, source: string): FileInfo {
  const r = file.rust;
  return {
    file, target: r?.target ?? file.path, lines: source.split('\n'),
    leaves: new Set((r?.useLeaves ?? []).map((p) => posKey(p.line, p.col))), modDecls: new Set(r?.modDecls ?? []),
  };
}

function inRanges(ranges: readonly [number, number][], row: number): boolean {
  return ranges.some(([a, b]) => row >= a && row <= b);
}

/** 提取层建了符号的定义：函数和方法（`().`）、类型和 trait（`#`）、文件级模块；宏调用里的定义不算 */
function keepDefinition(occ: ScipOccurrence, info: FileInfo): boolean {
  if (isFileModuleDefinition(occ)) return true;
  if (!occ.symbol.endsWith('().') && !occ.symbol.endsWith('#')) return false;
  return !inRanges(info.file.rust?.macroRanges ?? [], occ.range.startLine);
}

/** 引用后面（跳过空白）紧跟 `::`：是路径的中间段 */
function isPathPrefix(info: FileInfo, occ: ScipOccurrence): boolean {
  const r = occ.range;
  return r.startLine === r.endLine && (info.lines[r.startLine] ?? '').slice(r.endChar).trimStart().startsWith('::');
}

/** 保留的引用：`mod x;` 行上的不要；`use` 行里只要叶子；其他行去掉路径中间段 */
function keepReference(occ: ScipOccurrence, info: FileInfo): boolean {
  const row = occ.range.startLine;
  if (info.modDecls.has(row)) return false;
  const leaf = info.leaves.has(posKey(row, occ.range.startChar));
  if (inRanges(info.file.importRows, row)) return leaf;
  return leaf || !isPathPrefix(info, occ);
}

/** 符号 → 定义它的 crate 目标集合 */
function definitionTargets(docs: [ScipDocument, FileInfo][]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [doc, info] of docs) {
    for (const occ of doc.occurrences) {
      if (!(occ.roles & SCIP_ROLE_DEFINITION) || occ.symbol.startsWith('local ') || !keepDefinition(occ, info)) continue;
      const set = out.get(occ.symbol) ?? new Set<string>();
      set.add(info.target);
      out.set(occ.symbol, set);
    }
  }
  return out;
}

interface DuplicateContext {
  targets: Map<string, Set<string>>;
  libRoots: ReadonlySet<string>;
}

/**
 * 多个 crate 目标里都有定义的符号加上目标后缀：定义用自己的目标；引用优先用引用所在目标的定义，
 * 没有时用 lib 目标的定义；都没有时返回 undefined（丢弃这条引用）
 */
function targetSymbol(occ: ScipOccurrence, info: FileInfo, dup: DuplicateContext): string | undefined {
  const targets = dup.targets.get(occ.symbol);
  if (!targets || targets.size < 2) return occ.symbol;
  if (targets.has(info.target)) return `${occ.symbol}${TARGET_SEP}${info.target}`;
  if (occ.roles & SCIP_ROLE_DEFINITION) return undefined;
  const lib = [...targets].find((t) => dup.libRoots.has(t));
  return lib === undefined ? undefined : `${occ.symbol}${TARGET_SEP}${lib}`;
}

function countDefinition(occ: ScipOccurrence, info: FileInfo, stats: RustDefinitionStats): void {
  if (isFileModuleDefinition(occ)) return;
  stats.definitions++;
  if (info.file.symbols.some((x) => x.nameLine === occ.range.startLine && x.nameCol === occ.range.startChar)) stats.matchedByPosition++;
}

function prepareDocument(doc: ScipDocument, info: FileInfo, dup: DuplicateContext, stats: RustDefinitionStats): ScipDocument {
  const occurrences: ScipOccurrence[] = [];
  for (const occ of doc.occurrences) {
    if (occ.symbol.startsWith('local ')) continue;
    const isDef = (occ.roles & SCIP_ROLE_DEFINITION) !== 0;
    if (isDef ? !keepDefinition(occ, info) : !keepReference(occ, info)) continue;
    const symbol = targetSymbol(occ, info, dup);
    if (symbol === undefined) continue;
    if (isDef) countDefinition(occ, info, stats);
    occurrences.push(symbol === occ.symbol ? occ : { ...occ, symbol });
  }
  return { relativePath: doc.relativePath, occurrences };
}

/**
 * rust-analyzer 索引交给 scipToEdges 之前的 Rust 处理：去掉不在文件清单里的文档和局部符号；
 * 只留提取层建了符号的定义；多个 crate 目标重名的符号按目标区分；去掉路径中间段、`use` 里非叶子的引用和 `mod x;` 行上的引用。
 * sources 为各文件的源码（判断路径中间段）
 */
export function prepareRustIndex(
  index: ScipIndex, files: readonly ExtractedFile[], sources: ReadonlyMap<string, string>, packages: ReadonlyMap<string, RustPackage>,
): { index: ScipIndex; stats: RustDefinitionStats } {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const docs: [ScipDocument, FileInfo][] = [];
  for (const doc of index.documents) {
    const file = byPath.get(doc.relativePath);
    if (file) docs.push([doc, fileInfo(file, sources.get(file.path) ?? '')]);
  }
  const libRoots = new Set([...packages.values()].flatMap((p) => p.targets.filter((t) => t.kind === 'lib').map((t) => t.root)));
  const dup: DuplicateContext = { targets: definitionTargets(docs), libRoots };
  const stats: RustDefinitionStats = { definitions: 0, matchedByPosition: 0 };
  return { index: { documents: docs.map(([doc, info]) => prepareDocument(doc, info, dup, stats)) }, stats };
}
