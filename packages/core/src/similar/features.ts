import { shingles } from '../extract/normalize.js';
import { detectLanguage } from '../model/language.js';
import type { SymbolRow } from '../model/types.js';
import { jaccard } from '../util/collections.js';

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

/** Go 处理函数字面量的符号名（funcN、嵌套的 funcN.M，包级变量里的也是这个形式），由编号生成，不反映用途 */
const GO_LITERAL_NAME = /^func\d+(\.\d+)*$/;

/** Rust 作为路由处理函数的闭包的符号名（closureN），由编号生成，不反映用途 */
const RUST_CLOSURE_NAME = /^closure\d+$/;

/** 按编号生成的名字（Go 函数字面量、Rust 闭包），不说明用途 */
function isLiteralName(f: FunctionFeatures): boolean {
  return (f.language === 'go' && GO_LITERAL_NAME.test(f.symbol.name)) || (f.language === 'rust' && RUST_CLOSURE_NAME.test(f.symbol.name));
}

/** 名字相同为 1，否则为切词后 token 集合的 Jaccard；Go 函数字面量、Rust 闭包的编号名字不说明相似，记 0 */
export function nameSimilarity(a: FunctionFeatures, b: FunctionFeatures): number {
  if (isLiteralName(a) || isLiteralName(b)) return 0;
  if (a.symbol.name === b.symbol.name) return 1;
  return jaccard(a.nameTokens, b.nameTokens);
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
 * Python 签名形状：参数个数（不含方法的 self / cls，以及 `*`、`/` 分隔符）和是否有返回值。
 * 有返回注解时以注解为准（`-> None` 为没有返回值）；没有注解时看函数体里有没有 return。
 */
function pythonSignatureShape(s: SymbolRow): SignatureShape {
  const sig = s.displaySignature;
  const close = sig.startsWith('(') ? closingParen(sig) : -1;
  let params = close > 0 ? splitTopLevel(sig.slice(1, close)).filter((p) => p !== '*' && p !== '/') : [];
  if (s.kind === 'method' && params.length > 0 && /^(self|cls)\b/.test(params[0]!)) params = params.slice(1);
  const ret = close > 0 ? sig.slice(close + 1).trim() : '';
  const annotated = ret.startsWith('->');
  const returnsValue = annotated ? ret.slice(2).trim() !== 'None' : s.normTokens.includes('return');
  return { params: params.length, returnsValue };
}

/** 方括号外第一个 `(` 的位置（跳过名字后的类型参数 `[T any]`） */
function firstParenOutsideBrackets(sig: string): number {
  let depth = 0;
  for (let i = 0; i < sig.length; i++) {
    const ch = sig[i]!;
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    else if (ch === '(' && depth === 0) return i;
  }
  return -1;
}

/**
 * Go 签名形状：`func (接收者) 名字[类型参数](参数) 返回值`，interface 方法为 `名字(参数) 返回值`。
 * 接收者不算参数；`a, b int` 算两个参数；写了返回值（单个或 `(T, error)` 多个）就算有返回值
 */
function goSignatureShape(s: SymbolRow): SignatureShape {
  let sig = s.displaySignature.replace(/^func\b\s*/, '');
  if (s.kind === 'method' && s.displaySignature.startsWith('func') && sig.startsWith('(')) sig = sig.slice(closingParen(sig) + 1).trimStart();
  const open = firstParenOutsideBrackets(sig);
  if (open < 0) return { params: 0, returnsValue: false };
  const rest = sig.slice(open);
  const close = closingParen(rest);
  if (close < 0) return { params: 0, returnsValue: false };
  return { params: splitTopLevel(rest.slice(1, close)).length, returnsValue: rest.slice(close + 1).trim() !== '' };
}

/**
 * 按 Rust 的括号和尖括号配对切分（`->` 里的 `>` 不算）：返回 `(` 之后到配对 `)` 之间的顶层逗号分段和 `)` 之后的文字。
 * Rust 签名里的 `'a` 是生命周期，不按引号处理
 */
function rustParamsAndRest(sig: string, open: number): { params: string[]; rest: string } | undefined {
  const params: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = open + 1; i < sig.length; i++) {
    const ch = sig[i]!;
    if (ch === '-' && sig[i + 1] === '>') {
      cur += '->';
      i++;
      continue;
    }
    if ('([{<'.includes(ch)) depth++;
    else if ('}]>'.includes(ch)) depth--;
    else if (ch === ')' && depth-- === 0) {
      if (cur.trim()) params.push(cur.trim());
      return { params, rest: sig.slice(i + 1).trim() };
    } else if (ch === ',' && depth === 0) {
      params.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  return undefined;
}

/** `fn 名字<类型参数>` 之后、尖括号外的第一个 `(`（类型参数里可能有 `Fn(A) -> B`） */
function rustParamsOpen(sig: string): number {
  const fn = /\bfn\s/.exec(sig);
  if (!fn) return -1;
  let depth = 0;
  for (let i = fn.index + 3; i < sig.length; i++) {
    const ch = sig[i]!;
    if (ch === '-' && sig[i + 1] === '>') i++;
    else if (ch === '<') depth++;
    else if (ch === '>') depth--;
    else if (ch === '(' && depth === 0) return i;
  }
  return -1;
}

const RUST_SELF_PARAM = /^(&\s*('\w+\s+)?)?(mut\s+)?self\b/;

/** Rust 签名形状：参数不含 `self`（`&self`、`&mut self`、`self: Box<Self>` 等）；写了 `->` 且不是 `()` 就算有返回值 */
function rustSignatureShape(s: SymbolRow): SignatureShape {
  const sig = s.displaySignature;
  const open = rustParamsOpen(sig);
  const parsed = open < 0 ? undefined : rustParamsAndRest(sig, open);
  if (!parsed) return { params: 0, returnsValue: false };
  const params = parsed.params.filter((p) => !RUST_SELF_PARAM.test(p));
  const ret = /^->\s*(.*?)(\s+where\b.*)?$/.exec(parsed.rest)?.[1]?.trim();
  return { params: params.length, returnsValue: ret !== undefined && ret !== '' && ret !== '()' };
}

/** 签名形状：参数个数和是否有返回值，按符号所在文件的语言解析签名 */
export function signatureShape(s: SymbolRow): SignatureShape {
  const language = detectLanguage(s.path);
  if (language === 'go') return goSignatureShape(s);
  if (language === 'rust') return rustSignatureShape(s);
  return pythonSignatureShape(s);
}

/** 参数个数相似度（少的 / 多的，都为 0 时为 1）和返回值是否一致各占一半 */
export function shapeSimilarity(a: SignatureShape, b: SignatureShape): number {
  const max = Math.max(a.params, b.params);
  const count = max === 0 ? 1 : Math.min(a.params, b.params) / max;
  return 0.5 * count + 0.5 * (a.returnsValue === b.returnsValue ? 1 : 0);
}

export function bodySimilarityOf(a: FunctionFeatures, b: FunctionFeatures): number {
  return jaccard(a.shingles, b.shingles);
}

/** 函数体行数：范围的总行数减去定义行（装饰器和多行签名会让它偏大，只用于排除太短的函数） */
export function bodyLines(s: SymbolRow): number {
  return s.endLine - s.startLine;
}

type SimilarityKindInput = Pick<SymbolRow, 'kind' | 'path' | 'displaySignature'>;

/** Go interface 里声明的方法：没有函数体，签名不以 `func` 开头 */
function isGoInterfaceMethod(s: SimilarityKindInput): boolean {
  return s.kind === 'method' && detectLanguage(s.path) === 'go' && !s.displaySignature.startsWith('func');
}

/** 能作为相似比较对象的符号：函数或方法，Go interface 方法除外 */
export function isSimilarityKind(s: SimilarityKindInput): boolean {
  return FUNCTION_KINDS.has(s.kind) && !isGoInterfaceMethod(s);
}

/** 参与重复实现检测的函数：函数或方法（Go interface 方法除外）、非测试、非生成代码（同名重复规则不看函数体长度） */
export function isCheckedFunction(s: SymbolRow): boolean {
  return isSimilarityKind(s) && !s.isTest && !s.isGenerated;
}

/** 能参与常规比较的函数：在 isCheckedFunction 之外，函数体不少于 3 行 */
export function isComparableFunction(s: SymbolRow): boolean {
  return isCheckedFunction(s) && bodyLines(s) >= MIN_BODY_LINES;
}

/** Go 里各包惯用的同名函数：程序入口、包初始化和构造函数，同名不说明重复 */
function isGoConventionalName(name: string): boolean {
  return name === 'main' || name === 'init' || /^New(?![a-z])/.test(name);
}

/** qualifiedName 去掉最后一段（Go 函数得到包路径，方法得到 `包路径.类型`） */
function stripLast(qn: string): string {
  return qn.slice(0, qn.lastIndexOf('.'));
}

/** 符号所在的包路径：函数去掉函数名 */
function goPackageOf(s: SymbolRow): string {
  return stripLast(s.qualifiedName);
}

/**
 * Go 的同名重复额外条件：
 * - 方法一律不算：同一个包里的同名方法是构建标签变体，不同包里的同名方法多是惯用的接口式名字（如各包的 `Config.Validate`）；
 * - 函数只有包路径不同才算，同一个包里不同文件的同名函数是构建标签变体（x_linux.go / x_windows.go）；
 * - main、init、New 开头的函数和函数字面量的 funcN 名字不算。
 */
function goSameNameAllowed(a: FunctionFeatures, b: FunctionFeatures): boolean {
  if (a.symbol.kind === 'method' || b.symbol.kind === 'method') return false;
  if (goPackageOf(a.symbol) === goPackageOf(b.symbol)) return false;
  return !isGoConventionalName(a.symbol.name) && !isLiteralName(a);
}

/** Rust 里各类型、各 crate 惯用的同名函数：程序入口、构造和常见 trait 方法名，同名不说明重复 */
const RUST_CONVENTIONAL_NAMES: ReadonlySet<string> = new Set(['main', 'new', 'default', 'fmt', 'from', 'drop']);

/** Rust 符号所在的模块路径：qualifiedName 去掉最后一段 */
function rustModuleOf(s: SymbolRow): string {
  return s.qualifiedName.slice(0, s.qualifiedName.lastIndexOf('::'));
}

/**
 * Rust 的同名重复额外条件：方法一律不算（各类型实现同一个 trait 方法是常态）；函数只有模块路径不同才算；
 * main、new、default、fmt、from、drop 和闭包符号不算
 */
function rustSameNameAllowed(a: FunctionFeatures, b: FunctionFeatures): boolean {
  if (a.symbol.kind === 'method' || b.symbol.kind === 'method') return false;
  if (rustModuleOf(a.symbol) === rustModuleOf(b.symbol)) return false;
  return !RUST_CONVENTIONAL_NAMES.has(a.symbol.name) && !isLiteralName(a);
}

/** 各语言在“名字和签名形状都相同”之外的同名重复条件 */
function sameNameAllowed(a: FunctionFeatures, b: FunctionFeatures): boolean {
  if (a.language === 'go') return goSameNameAllowed(a, b);
  if (a.language === 'rust') return rustSameNameAllowed(a, b);
  return true;
}

/**
 * 同名重复：不同文件里名字完全相同、签名形状也相同（参数个数相同、是否有返回值一致）；Go、Rust 另见 goSameNameAllowed、rustSameNameAllowed。
 * 同一文件里的同名是重复定义（qualified_name 带 `#2`），不算。
 */
export function isSameNameDuplicate(a: FunctionFeatures, b: FunctionFeatures): boolean {
  return (
    a.symbol.name === b.symbol.name &&
    a.symbol.path !== b.symbol.path &&
    a.shape.params === b.shape.params &&
    a.shape.returnsValue === b.shape.returnsValue &&
    sameNameAllowed(a, b)
  );
}

/** Rust trait 里只有声明、没有函数体的方法：提取时没有函数体的规范化 token */
function isRustDeclarationOnly(s: SymbolRow, language: string): boolean {
  return language === 'rust' && s.kind === 'method' && s.normTokens.length === 0;
}

/** 比较用的特征；Rust trait 里没有函数体的方法不参与常规比较（方法也不参与同名重复，因此完全不参与） */
export function functionFeatures(s: SymbolRow): FunctionFeatures {
  const language = detectLanguage(s.path);
  return {
    symbol: s,
    comparable: isComparableFunction(s) && !isRustDeclarationOnly(s, language),
    language,
    nameTokens: nameTokens(s.name),
    shingles: shingles(s.normTokens),
    shape: signatureShape(s),
  };
}
