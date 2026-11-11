import { shingleJaccard, shingles } from '../extract/normalize.js';
import { detectLanguage } from '../model/language.js';
import type { SymbolRow } from '../model/types.js';

/** 参与重复实现比较的符号类型 */
export const FUNCTION_KINDS = new Set(['function', 'method']);

/** 函数体不足这么多行时不参与比较（太短的函数相似没有意义） */
export const MIN_BODY_LINES = 3;

/** 一个函数参与比较所需的全部特征，按符号算一次后反复使用 */
export interface FunctionFeatures {
  symbol: SymbolRow;
  /** 能参与按名字切词和函数体的常规比较（函数体不少于 3 行）；否则只参与同名重复规则 */
  comparable: boolean;
  language: string;
  nameTokens: Set<string>;
  shingles: Set<string>;
  shape: SignatureShape;
}

export interface SignatureShape {
  params: number;
  returnsValue: boolean;
}

/** 名字按 snake_case / camelCase 切词，转小写；开头的下划线等空片段丢弃 */
export function nameTokens(name: string): Set<string> {
  const parts = name
    .split(/[_\W]+/)
    .flatMap((p) => p.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/))
    .map((p) => p.toLowerCase())
    .filter((p) => p.length > 0);
  return new Set(parts);
}

/** 名字相同为 1，否则为切词后 token 集合的 Jaccard */
export function nameSimilarity(a: FunctionFeatures, b: FunctionFeatures): number {
  if (a.symbol.name === b.symbol.name) return 1;
  return setJaccard(a.nameTokens, b.nameTokens);
}

function setJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 按顶层逗号切分参数列表，跳过括号、方括号、花括号和字符串里的逗号 */
function splitTopLevel(params: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let cur = '';
  for (let i = 0; i < params.length; i++) {
    const ch = params[i]!;
    if (quote) {
      if (ch === '\\') cur += ch + (params[++i] ?? '');
      else {
        if (ch === quote) quote = undefined;
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 找到和开头 `(` 配对的 `)` 的位置 */
function closingParen(sig: string): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < sig.length; i++) {
    const ch = sig[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

/**
 * 签名形状：参数个数（不含方法的 self / cls，以及 `*`、`/` 分隔符）和是否有返回值。
 * 有返回注解时以注解为准（`-> None` 为没有返回值）；没有注解时看函数体里有没有 return。
 */
export function signatureShape(s: SymbolRow): SignatureShape {
  const sig = s.displaySignature;
  const close = sig.startsWith('(') ? closingParen(sig) : -1;
  let params = close > 0 ? splitTopLevel(sig.slice(1, close)).filter((p) => p !== '*' && p !== '/') : [];
  if (s.kind === 'method' && params.length > 0 && /^(self|cls)\b/.test(params[0]!)) params = params.slice(1);
  const ret = close > 0 ? sig.slice(close + 1).trim() : '';
  const annotated = ret.startsWith('->');
  const returnsValue = annotated ? ret.slice(2).trim() !== 'None' : s.normTokens.includes('return');
  return { params: params.length, returnsValue };
}

/** 参数个数相似度（少的 / 多的，都为 0 时为 1）和返回值是否一致各占一半 */
export function shapeSimilarity(a: SignatureShape, b: SignatureShape): number {
  const max = Math.max(a.params, b.params);
  const count = max === 0 ? 1 : Math.min(a.params, b.params) / max;
  return 0.5 * count + 0.5 * (a.returnsValue === b.returnsValue ? 1 : 0);
}

export function bodySimilarityOf(a: FunctionFeatures, b: FunctionFeatures): number {
  return shingleJaccard(a.shingles, b.shingles);
}

/** 函数体行数：范围的总行数减去定义行（装饰器和多行签名会让它偏大，只用于排除太短的函数） */
export function bodyLines(s: SymbolRow): number {
  return s.endLine - s.startLine;
}

/** 参与重复实现检测的函数：函数或方法、非测试、非生成代码（同名重复规则不看函数体长度） */
export function isCheckedFunction(s: SymbolRow): boolean {
  return FUNCTION_KINDS.has(s.kind) && !s.isTest && !s.isGenerated;
}

/** 能参与常规比较的函数：在 isCheckedFunction 之外，函数体不少于 3 行 */
export function isComparableFunction(s: SymbolRow): boolean {
  return isCheckedFunction(s) && bodyLines(s) >= MIN_BODY_LINES;
}

/**
 * 同名重复：不同文件里名字完全相同、签名形状也相同（参数个数相同、是否有返回值一致）。
 * 同一文件里的同名是重复定义（qualified_name 带 `#2`），不算。
 */
export function isSameNameDuplicate(a: FunctionFeatures, b: FunctionFeatures): boolean {
  return (
    a.symbol.name === b.symbol.name &&
    a.symbol.path !== b.symbol.path &&
    a.shape.params === b.shape.params &&
    a.shape.returnsValue === b.shape.returnsValue
  );
}

export function functionFeatures(s: SymbolRow): FunctionFeatures {
  return {
    symbol: s,
    comparable: isComparableFunction(s),
    language: detectLanguage(s.path),
    nameTokens: nameTokens(s.name),
    shingles: shingles(s.normTokens),
    shape: signatureShape(s),
  };
}
