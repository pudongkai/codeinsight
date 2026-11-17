import type { Node } from 'web-tree-sitter';
import { goSelectorParts } from './go-syntax.js';
import type { GoTypeChain } from './types.js';

/** 解析类型名需要的文件信息：本包导入路径和导入名表 */
export interface GoTypeContext {
  packagePath: string;
  imports: Readonly<Record<string, string>>;
}

/**
 * 一个函数内变量名 → 类型线索，类型推断不出的变量为 null（仍要记下，用来区分局部变量和包级函数、导入名）；
 * 只有 for / if / switch / 函数字面量自己声明的变量离开语句后恢复，代码块里普通的 `:=` 不按代码块区分作用域
 */
export type GoVarTypes = Map<string, GoTypeChain | null>;

/** 跨文件查找类型信息：struct 字段类型、函数的第一个返回类型（都按 qualifiedName） */
export interface GoTypeLookup {
  field(typeName: string, field: string): string | undefined;
  funcResult(funcName: string): string | undefined;
}

const BUILTIN_TYPES = new Set([
  'bool', 'byte', 'complex64', 'complex128', 'error', 'float32', 'float64', 'int', 'int8', 'int16', 'int32', 'int64',
  'rune', 'string', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr', 'any', 'comparable',
]);

/** 类型节点 → 类型的 qualifiedName（`<包导入路径>.T`）：支持 T、*T、pkg.T、T[X]；切片、map、函数、内置类型等为 undefined */
export function typeQualifiedName(node: Node | null | undefined, ctx: GoTypeContext): string | undefined {
  switch (node?.type) {
    case 'type_identifier':
      return BUILTIN_TYPES.has(node.text) ? undefined : `${ctx.packagePath}.${node.text}`;
    case 'pointer_type':
    case 'parenthesized_type':
      return typeQualifiedName(node.namedChildren[0], ctx);
    case 'generic_type':
      return typeQualifiedName(node.childForFieldName('type'), ctx);
    case 'qualified_type': {
      const path = ownValue(ctx.imports, node.childForFieldName('package')?.text ?? '');
      const name = node.childForFieldName('name')?.text;
      return path && name ? `${path}.${name}` : undefined;
    }
    default:
      return undefined;
  }
}

function typeChain(type: string | undefined): GoTypeChain | undefined {
  return type ? { root: { type }, fields: [] } : undefined;
}

/** `pkg` 是导入名且没有被同名局部变量遮住 */
export function isImportName(name: string, ctx: GoTypeContext, vars: GoVarTypes): boolean {
  return ownValue(ctx.imports, name) !== undefined && !vars.has(name);
}

/** 被调函数是包级函数（`F()` 或 `pkg.F()`）时返回它的 qualifiedName */
function calleeName(fn: Node | null, ctx: GoTypeContext, vars: GoVarTypes): string | undefined {
  if (fn?.type === 'identifier') return vars.has(fn.text) ? undefined : `${ctx.packagePath}.${fn.text}`;
  const sel = goSelectorParts(fn);
  if (sel?.operand.type !== 'identifier' || !isImportName(sel.operand.text, ctx, vars)) return undefined;
  return `${ctx.imports[sel.operand.text]}.${sel.field}`;
}

/** 表达式的类型线索：变量、字段访问、`T{}`、`&T{}`、包级函数调用（取第一个返回类型）；推断不出时为 undefined */
export function exprChain(expr: Node | null | undefined, ctx: GoTypeContext, vars: GoVarTypes): GoTypeChain | undefined {
  switch (expr?.type) {
    case 'identifier':
      return vars.get(expr.text) ?? undefined;
    case 'parenthesized_expression':
      return exprChain(expr.namedChildren[0], ctx, vars);
    case 'unary_expression':
      return expr.child(0)?.text === '&' ? exprChain(expr.childForFieldName('operand'), ctx, vars) : undefined;
    case 'composite_literal':
      return typeChain(typeQualifiedName(expr.childForFieldName('type'), ctx));
    case 'call_expression': {
      const ctor = calleeName(expr.childForFieldName('function'), ctx, vars);
      return ctor ? { root: { ctor }, fields: [] } : undefined;
    }
    case 'selector_expression': {
      const sel = goSelectorParts(expr);
      if (!sel || (sel.operand.type === 'identifier' && isImportName(sel.operand.text, ctx, vars))) return undefined;
      const base = exprChain(sel.operand, ctx, vars);
      return base ? { root: base.root, fields: [...base.fields, sel.field] } : undefined;
    }
    default:
      return undefined;
  }
}

/** 参数列表（接收者、参数、函数字面量的参数）里的变量按声明的类型记下 */
export function declareParams(list: Node | null | undefined, ctx: GoTypeContext, vars: GoVarTypes): void {
  for (const p of list?.namedChildren ?? []) {
    if (p.type !== 'parameter_declaration' && p.type !== 'variadic_parameter_declaration') continue;
    const chain = p.type === 'parameter_declaration' ? typeChain(typeQualifiedName(p.childForFieldName('type'), ctx)) : undefined;
    for (const n of p.childrenForFieldName('name')) setVar(vars, n.text, chain);
  }
}

function setVar(vars: GoVarTypes, name: string, chain: GoTypeChain | undefined): void {
  if (name !== '_') vars.set(name, chain ?? null);
}

/** 左右两边按位置对应；右边只有一个表达式（多返回值）时只有第一个变量取它的类型 */
function assignPairs(names: string[], values: Node[], ctx: GoTypeContext, vars: GoVarTypes): void {
  const chains = values.map((v) => exprChain(v, ctx, vars));
  names.forEach((name, i) => setVar(vars, name, values.length === names.length || i === 0 ? chains[i] : undefined));
}

/** 节点下一层 expression_list 里的变量名 */
function listNames(list: Node | null): string[] {
  return (list?.namedChildren ?? []).map((n) => n.text);
}

/**
 * 进入子节点之前就要记下的变量：`switch v := x.(type)` 的 v 在各个 case 里可见，类型随 case 变化，记为 null。
 * 这样同名的导入名在 case 里被遮住，`v.M()` 不会当成包函数调用
 */
export function recordScopeDeclaration(node: Node, vars: GoVarTypes): void {
  if (node.type === 'type_switch_statement') for (const n of listNames(node.childForFieldName('alias'))) setVar(vars, n, undefined);
}

/** 初始化语句（`if x := e; ...`、`for i := 0; ...`）里 `:=` 声明的变量名 */
function initializerNames(init: Node | null): string[] {
  return init?.type === 'short_var_declaration' ? listNames(init.childForFieldName('left')) : [];
}

/**
 * 只在这个语句内可见的变量名：range / for 子句、if / switch 初始化语句、type switch 别名、函数字面量参数。
 * 遍历这个节点前保存这些名字原来的记录，遍历完恢复，避免在语句之后继续遮住同名导入名或外层变量
 */
export function blockScopedNames(node: Node): string[] {
  switch (node.type) {
    case 'func_literal':
      return (node.childForFieldName('parameters')?.namedChildren ?? []).flatMap((p) => p.childrenForFieldName('name').map((n) => n.text));
    case 'for_statement': {
      const clause = node.namedChildren.find((n) => n.type === 'range_clause' || n.type === 'for_clause');
      if (clause?.type === 'range_clause') return clause.child(1)?.text === ':=' ? listNames(clause.childForFieldName('left')) : [];
      return initializerNames(clause?.childForFieldName('initializer') ?? null);
    }
    case 'type_switch_statement':
      return [...listNames(node.childForFieldName('alias')), ...initializerNames(node.childForFieldName('initializer'))];
    case 'if_statement':
    case 'expression_switch_statement':
      return initializerNames(node.childForFieldName('initializer'));
    default:
      return [];
  }
}

/** 保存 names 当前的记录，返回的函数把它们恢复原样（原来没有的删掉） */
export function saveVars(names: string[], vars: GoVarTypes): () => void {
  const saved = names.map((n) => [n, vars.has(n), vars.get(n)] as const);
  return () => {
    for (const [n, had, v] of saved) {
      if (had) vars.set(n, v ?? null);
      else vars.delete(n);
    }
  };
}

/** `var x T`、`var x = e`、`x := e` 声明的变量类型记进 vars；`for k, v := range e` 的变量类型推断不出，记为 null；其他节点不处理 */
export function recordDeclaration(node: Node, ctx: GoTypeContext, vars: GoVarTypes): void {
  if (node.type === 'var_spec') {
    const names = node.childrenForFieldName('name').map((n) => n.text);
    const type = node.childForFieldName('type');
    if (type) for (const n of names) setVar(vars, n, typeChain(typeQualifiedName(type, ctx)));
    else assignPairs(names, node.childForFieldName('value')?.namedChildren ?? [], ctx, vars);
  } else if (node.type === 'short_var_declaration') {
    assignPairs(listNames(node.childForFieldName('left')), node.childForFieldName('right')?.namedChildren ?? [], ctx, vars);
  } else if (node.type === 'range_clause' && node.child(1)?.text === ':=') {
    for (const n of listNames(node.childForFieldName('left'))) setVar(vars, n, undefined);
  }
}

/** 按 lookup 把类型线索算成类型的 qualifiedName；中途任一步查不到时为 undefined */
export function resolveChain(chain: GoTypeChain, lookup: GoTypeLookup): string | undefined {
  let type = 'type' in chain.root ? chain.root.type : lookup.funcResult(chain.root.ctor);
  for (const f of chain.fields) {
    if (type === undefined) return undefined;
    type = lookup.field(type, f);
  }
  return type;
}

/** 按 qualifiedName 最后一个 `.` 拆成包导入路径和名字 */
export function splitQualified(name: string): [string, string] {
  const i = name.lastIndexOf('.');
  return [name.slice(0, i), name.slice(i + 1)];
}

/** 只取对象自身的键（不取原型链上的 toString 等） */
export function ownValue<T>(rec: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return rec && Object.hasOwn(rec, key) ? rec[key] : undefined;
}

/** 只用一个文件自己的 struct 字段和函数返回类型做查找 */
export function fileTypeLookup(
  packagePath: string, structFields: Record<string, Record<string, string>>, funcResults: Record<string, string>,
): GoTypeLookup {
  const own = (qn: string): string | undefined => {
    const [pkg, name] = splitQualified(qn);
    return pkg === packagePath ? name : undefined;
  };
  return {
    field: (t, f) => { const n = own(t); return n === undefined ? undefined : ownValue(ownValue(structFields, n), f); },
    funcResult: (fn) => { const n = own(fn); return n === undefined ? undefined : ownValue(funcResults, n); },
  };
}
