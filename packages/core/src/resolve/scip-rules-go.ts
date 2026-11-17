import type { GoSymbolIndex } from '../extract/go-index.js';
import type { ExtractedFile } from '../extract/types.js';
import { SCIP_ROLE_DEFINITION, type ScipDocument, type ScipIndex, type ScipOccurrence } from '../scip/reader.js';
import type { ScipLanguageRules } from './scip-rules.js';

/** scip-go 的项目内符号：`scip-go gomod <module> <版本> <其余>` */
const GOMOD_SYMBOL = /^scip-go gomod (\S+) (\S+) (.*)$/;
/** 包定义：以 `` `<包导入路径>`/ `` 结尾 */
const PACKAGE_SYMBOL = /`([^`]+)`\/$/;

/** 跳过字符串、字符字面量、反引号字符串和注释，按括号配对计算每行结束时是否还在括号里 */
export function goContinuedLines(source: string): boolean[] {
  const out: boolean[] = [];
  let depth = 0;
  let mode: 'code' | 'block' | 'raw' = 'code';
  for (const line of source.split('\n')) {
    let i = 0;
    while (i < line.length) {
      const ch = line[i]!;
      if (mode === 'block') {
        if (line.startsWith('*/', i)) { mode = 'code'; i += 2; } else i++;
      } else if (mode === 'raw') {
        if (ch === '`') mode = 'code';
        i++;
      } else if (line.startsWith('//', i)) {
        break;
      } else if (line.startsWith('/*', i)) {
        mode = 'block';
        i += 2;
      } else if (ch === '`') {
        mode = 'raw';
        i++;
      } else if (ch === '"' || ch === "'") {
        i = skipQuoted(line, i);
      } else {
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
        i++;
      }
    }
    out.push(depth > 0 || mode !== 'code');
  }
  return out;
}

/** 从引号位置跳到配对的引号之后；行内没有配对时到行尾 */
function skipQuoted(line: string, start: number): number {
  const quote = line[start];
  let i = start + 1;
  while (i < line.length && line[i] !== quote) i += line[i] === '\\' ? 2 : 1;
  return i + 1;
}

export const goRules: ScipLanguageRules = {
  continuedLines: goContinuedLines,
  skipsRest: (rest) => rest.startsWith('//') || rest.startsWith('/*'),
  isModuleDefinition: (occ) => PACKAGE_SYMBOL.test(occ.symbol),
};

/** 预处理后的定义统计：参与对应的定义数、其中名字位置和提取层符号直接对上的个数 */
export interface GoDefinitionStats {
  definitions: number;
  matchedByPosition: number;
}

/**
 * 统一项目内 module 的符号版本：module 自己的索引里版本为 v0.0.0，经 go.work 或 replace 引用其他项目内 module 时
 * 版本为 `.` 等其他值，统一后跨 module 的引用才能对上定义
 */
function normalizeSymbol(symbol: string, modules: ReadonlySet<string>): string {
  const m = GOMOD_SYMBOL.exec(symbol);
  return m && modules.has(m[1]!) && m[2] !== 'v0.0.0' ? `scip-go gomod ${m[1]} v0.0.0 ${m[3]}` : symbol;
}

/** 提取层建了符号的定义：函数、方法、类型；`T#name.` 既可能是 interface 方法也可能是字段，要看位置上有没有提取的符号 */
function isTrackedDefinition(occ: ScipOccurrence, file: ExtractedFile): boolean {
  const s = occ.symbol;
  if (s.endsWith('().') || s.endsWith('#')) return true;
  if (!/#[^#/`]+\.$/.test(s)) return false;
  return file.symbols.some((x) => x.kind === 'method' && x.nameLine === occ.range.startLine && x.nameCol === occ.range.startChar);
}

/** 一个文档的定义按 Go 规则过滤：包定义只留在包的代表文件里，提取层没有对应符号的定义（字段、变量、常量）去掉 */
function keepDefinition(occ: ScipOccurrence, file: ExtractedFile, index: GoSymbolIndex): boolean {
  const pkg = PACKAGE_SYMBOL.exec(occ.symbol);
  if (pkg) return index.representative(pkg[1]!)?.path === file.path;
  return isTrackedDefinition(occ, file);
}

function prepareDocument(doc: ScipDocument, file: ExtractedFile, index: GoSymbolIndex, modules: ReadonlySet<string>, stats: GoDefinitionStats): ScipDocument {
  const occurrences: ScipOccurrence[] = [];
  for (const raw of doc.occurrences) {
    if (raw.symbol.startsWith('local ')) continue;
    const occ = { ...raw, symbol: normalizeSymbol(raw.symbol, modules) };
    if (occ.roles & SCIP_ROLE_DEFINITION) {
      if (!keepDefinition(occ, file, index)) continue;
      if (!PACKAGE_SYMBOL.test(occ.symbol)) {
        stats.definitions++;
        if (file.symbols.some((x) => x.nameLine === occ.range.startLine && x.nameCol === occ.range.startChar)) stats.matchedByPosition++;
      }
    }
    occurrences.push(occ);
  }
  return { relativePath: doc.relativePath, occurrences };
}

/**
 * scip-go 索引交给 scipToEdges 之前的 Go 处理：去掉不在文件清单里的文档和局部符号，统一项目内 module 的符号版本，
 * 每个文件 package 子句产生的包定义只保留代表文件的那一个（import 边和包引用都连到代表文件的 module 符号），
 * 去掉提取层不建符号的定义，避免算进“定义对不上”的比例
 */
export function prepareGoIndex(
  index: ScipIndex, files: readonly ExtractedFile[], symbols: GoSymbolIndex, modules: Iterable<string>,
): { index: ScipIndex; stats: GoDefinitionStats } {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const moduleSet = new Set(modules);
  const stats: GoDefinitionStats = { definitions: 0, matchedByPosition: 0 };
  const documents: ScipDocument[] = [];
  for (const doc of index.documents) {
    const file = byPath.get(doc.relativePath);
    if (file) documents.push(prepareDocument(doc, file, symbols, moduleSet, stats));
  }
  return { index: { documents }, stats };
}
