import type { Node } from 'web-tree-sitter';
import { goStringValue } from './go-syntax.js';

/** 一条 Go import */
export interface GoImport {
  path: string;
  /** 写明的导入名：别名、`_` 或 `.`；没写时为 undefined */
  alias?: string;
  /** import 所在行，0 起始 */
  line: number;
}

/** 文件里的全部 import（含 `_` 和 `.` 导入），按出现顺序 */
export function collectGoImports(root: Node): GoImport[] {
  const out: GoImport[] = [];
  for (const spec of root.descendantsOfType('import_spec')) {
    const path = goStringValue(spec.childForFieldName('path'));
    if (path === undefined) continue;
    const alias = spec.childForFieldName('name')?.text;
    out.push({ path, line: spec.startPosition.row, ...(alias ? { alias } : {}) });
  }
  return out;
}

/**
 * 没写导入名时的包名：取路径最后一段，去掉 `/v2` 这样的主版本段、`.v3` 后缀和 `go-` 前缀、`-go` 后缀。
 * 只是约定俗成的推测，包名和目录名不一致时会推错
 */
export function defaultImportName(importPath: string): string {
  const parts = importPath.split('/');
  let last = parts[parts.length - 1] ?? importPath;
  if (/^v\d+$/.test(last) && parts.length > 1) last = parts[parts.length - 2]!;
  return last.replace(/\.v\d+$/, '').replace(/^go-/, '').replace(/-go$/, '').replace(/[-.]/g, '_');
}

export interface GoImportBindings {
  /** 导入名 → import 路径；`_` 导入不在其中 */
  imports: Record<string, string>;
  /** `.` 导入的路径 */
  dotImports: string[];
}

/** import 列表转成导入名表 */
export function goImportBindings(list: readonly GoImport[]): GoImportBindings {
  const imports: Record<string, string> = {};
  const dotImports: string[] = [];
  for (const imp of list) {
    if (imp.alias === '_') continue;
    if (imp.alias === '.') dotImports.push(imp.path);
    else imports[imp.alias ?? defaultImportName(imp.path)] = imp.path;
  }
  return { imports, dotImports };
}

/** import 语句所在的行区间（0 起始，含两端） */
export function goImportRows(root: Node): [number, number][] {
  return root.descendantsOfType('import_declaration').map((n) => [n.startPosition.row, n.endPosition.row]);
}

const ENV_FUNCS = new Set(['Getenv', 'LookupEnv']);

/** 调用的是 os 包里读环境变量的函数：`os.Getenv`（含别名）或点导入 os 后的 `Getenv` */
function isEnvCall(fn: Node | null, b: GoImportBindings): boolean {
  if (fn?.type === 'identifier') return ENV_FUNCS.has(fn.text) && b.dotImports.includes('os');
  if (fn?.type !== 'selector_expression') return false;
  const operand = fn.childForFieldName('operand');
  return operand?.type === 'identifier' && Object.hasOwn(b.imports, operand.text) && b.imports[operand.text] === 'os' && ENV_FUNCS.has(fn.childForFieldName('field')?.text ?? '');
}

/** `os.Getenv` / `os.LookupEnv` 的字面量参数，去重后按出现顺序 */
export function collectGoEnvReads(root: Node, bindings = goImportBindings(collectGoImports(root))): string[] {
  const out = new Set<string>();
  for (const call of root.descendantsOfType('call_expression')) {
    if (!isEnvCall(call.childForFieldName('function'), bindings)) continue;
    const name = goStringValue(call.childForFieldName('arguments')?.namedChildren[0]);
    if (name) out.add(name);
  }
  return [...out];
}
