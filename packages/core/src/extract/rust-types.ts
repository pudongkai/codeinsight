import type { Node } from 'web-tree-sitter';
import { ownValue } from './go-types.js';
import { lastSegmentNode, position } from './rust-facts.js';
import { canonicalRustPath, rustPathOf, stripRaw } from './rust-syntax.js';
import type { RustCallSite, RustPathRef, RustTypeChain } from './types.js';

/** 一个项（函数、struct、impl、trait）里解析类型和路径用的上下文 */
export interface RustTypeScope {
  /** 完整模块路径（文件模块加内联 mod），用来换掉 `self`/`super` */
  modPath: string[];
  /** 所在的内联 mod（相对文件模块） */
  mod: string[];
  /** `Self` 指的类型路径；不在 impl 或 trait 里时没有 */
  selfType?: string[];
  /** 类型参数 → trait 路径（`R: Repo`、`where R: Repo`） */
  bounds: Record<string, string[]>;
  /** 函数体里 use 的绑定（名字 → 完整路径）；只在收集该函数的调用点时有 */
  localUses?: Record<string, string[]>;
}

/**
 * 一个函数内变量名 → 类型线索，推断不出的为 null（仍要记下，用来区分局部变量和同名函数）；
 * 不按代码块区分作用域
 */
export type RustVarTypes = Map<string, RustTypeChain | null>;

/** 推断时只看里面那一层的包装类型 */
const WRAPPERS = new Set(['Box', 'Arc', 'Rc', 'Option']);

/** 第一段是类型参数时换成它的 trait，`Self` 换成 selfType，`self`/`super` 换成 `crate` 开头 */
export function scopedPath(segments: readonly string[], scope: RustTypeScope): string[] | undefined {
  const [first, ...rest] = segments;
  if (first === undefined) return undefined;
  const bound = ownValue(scope.bounds, first);
  if (bound) return [...bound, ...rest];
  const local = scope.localUses && ownValue(scope.localUses, first);
  if (local) return [...local, ...rest];
  if (first === 'Self') return scope.selfType ? [...scope.selfType, ...rest] : undefined;
  return canonicalRustPath(segments, scope.modPath);
}

/** 类型参数列表里的第一个类型（跳过生命周期） */
function firstTypeArg(generic: Node): Node | undefined {
  return generic.childForFieldName('type_arguments')?.namedChildren.find((c) => c.type !== 'lifetime');
}

/**
 * 类型节点 → 类型路径：去掉 `&`、`&mut`、`Box<>`、`Arc<>`、`Rc<>`、`Option<>`，其他泛型去掉参数；
 * 类型参数和 `impl Trait`、`dyn Trait` 为对应 trait。基本类型、元组、切片等为 undefined
 */
export function rustTypePath(node: Node | null | undefined, scope: RustTypeScope): string[] | undefined {
  switch (node?.type) {
    case 'reference_type':
    case 'pointer_type':
      return rustTypePath(node.childForFieldName('type'), scope);
    case 'abstract_type':
    case 'dynamic_type':
      return rustTypePath(node.childForFieldName('trait'), scope);
    case 'bounded_type':
      return rustTypePath(node.namedChildren.find((c) => c.type !== 'lifetime'), scope);
    case 'generic_type': {
      const base = rustPathOf(node.childForFieldName('type'));
      if (base && WRAPPERS.has(base[base.length - 1]!)) return rustTypePath(firstTypeArg(node), scope);
      return base && scopedPath(base, scope);
    }
    case 'type_identifier':
    case 'scoped_type_identifier': {
      const p = rustPathOf(node);
      return p && scopedPath(p, scope);
    }
    default:
      return undefined;
  }
}

/** impl 目标类型的路径：去掉引用和泛型参数，`dyn Trait` 取 trait；不做类型参数替换 */
export function rustImplTypePath(node: Node | null | undefined, modPath: string[]): string[] | undefined {
  let t = node;
  while (t && (t.type === 'reference_type' || t.type === 'pointer_type')) t = t.childForFieldName('type');
  if (t?.type === 'bounded_type') t = t.namedChildren.find((c) => c.type !== 'lifetime');
  if (t?.type === 'dynamic_type') t = t.childForFieldName('trait');
  const p = rustPathOf(t);
  return p && canonicalRustPath(p, modPath);
}

/** trait_bounds 里第一个 trait 的路径 */
function firstBound(bounds: Node | null, scope: RustTypeScope): string[] | undefined {
  const b = bounds?.namedChildren.find((c) => c.type !== 'lifetime');
  return b ? rustTypePath(b, scope) : undefined;
}

/** 项的类型参数约束（`<R: Repo>` 和 where 子句），叠加在 scope.bounds 上 */
export function rustBounds(item: Node, scope: RustTypeScope): Record<string, string[]> {
  const out: Record<string, string[]> = { ...scope.bounds };
  const inner: RustTypeScope = { ...scope, bounds: {} };
  for (const p of item.childForFieldName('type_parameters')?.namedChildren ?? []) {
    const name = (p.childForFieldName('name') ?? p.childForFieldName('left'))?.text;
    const bound = firstBound(p.childForFieldName('bounds'), inner);
    if (name && bound) out[name] = bound;
  }
  const where = item.namedChildren.find((c) => c.type === 'where_clause');
  for (const p of where?.namedChildren ?? []) {
    const left = p.childForFieldName('left');
    const bound = firstBound(p.childForFieldName('bounds'), inner);
    if (left?.type === 'type_identifier' && bound) out[left.text] = bound;
  }
  return out;
}

function pathRef(segments: string[] | undefined, scope: RustTypeScope): RustPathRef | undefined {
  if (!segments) return undefined;
  return scope.mod.length > 0 ? { segments, mod: scope.mod } : { segments };
}

/** 函数的返回类型路径 */
export function rustFnResult(fn: Node, scope: RustTypeScope): RustPathRef | undefined {
  return pathRef(rustTypePath(fn.childForFieldName('return_type'), scope), scope);
}

/** struct 的具名字段 → 字段类型路径（推断不出的字段不记） */
export function rustStructFields(item: Node, scope: RustTypeScope): Record<string, RustPathRef> {
  const out: Record<string, RustPathRef> = {};
  const body = item.childForFieldName('body');
  if (body?.type !== 'field_declaration_list') return out;
  for (const f of body.namedChildren) {
    if (f.type !== 'field_declaration') continue;
    const name = f.childForFieldName('name')?.text;
    const ref = pathRef(rustTypePath(f.childForFieldName('type'), scope), scope);
    if (name && ref) out[stripRaw(name)] = ref;
  }
  return out;
}

/** 被调函数节点去掉 turbofish */
export function calleeNode(call: Node): Node | null {
  const fn = call.childForFieldName('function');
  return fn?.type === 'generic_function' ? fn.childForFieldName('function') : fn;
}

/** 表达式的类型线索：`self`、变量、字段访问、`T { .. }`、`T::f(..)` / `f(..)`（取返回类型）；推断不出时为 undefined */
export function rustExprChain(expr: Node | null | undefined, scope: RustTypeScope, vars: RustVarTypes): RustTypeChain | undefined {
  switch (expr?.type) {
    case 'self':
      return scope.selfType ? { root: { type: scope.selfType }, fields: [] } : undefined;
    case 'identifier':
      return vars.get(expr.text) ?? undefined;
    case 'parenthesized_expression':
    case 'try_expression':
    case 'await_expression':
      return rustExprChain(expr.namedChildren[0], scope, vars);
    case 'reference_expression':
      return rustExprChain(expr.childForFieldName('value'), scope, vars);
    case 'field_expression': {
      const field = expr.childForFieldName('field');
      const base = field?.type === 'field_identifier' ? rustExprChain(expr.childForFieldName('value'), scope, vars) : undefined;
      return base && field ? { root: base.root, fields: [...base.fields, field.text] } : undefined;
    }
    case 'struct_expression': {
      const p = rustPathOf(expr.childForFieldName('name'));
      const type = p && scopedPath(p, scope);
      return type ? { root: { type }, fields: [] } : undefined;
    }
    case 'call_expression': {
      const call = calleePath(calleeNode(expr), scope, vars);
      return call ? { root: { call }, fields: [] } : undefined;
    }
    default:
      return undefined;
  }
}

/** 路径形式被调函数的完整路径；被调的是局部变量（闭包）或不是路径时为 undefined */
function calleePath(fn: Node | null, scope: RustTypeScope, vars: RustVarTypes): string[] | undefined {
  if (!fn || fn.type === 'field_expression') return undefined;
  const p = rustPathOf(fn);
  if (!p || (p.length === 1 && vars.has(p[0]!))) return undefined;
  return scopedPath(p, scope);
}

/** 模式里绑定的变量名（跳过 `Some(x)`、`Foo::Bar { .. }` 这类类型路径） */
function patternNames(p: Node | null | undefined): string[] {
  if (!p) return [];
  if (p.type === 'identifier' || p.type === 'shorthand_field_identifier') return [p.text];
  if (p.type === 'scoped_identifier' || p.type === 'field_identifier') return [];
  if (p.type === 'match_pattern') return patternNames(p.namedChildren.find((c) => c.id !== p.childForFieldName('condition')?.id));
  const typeNode = p.childForFieldName('type');
  return p.namedChildren.filter((c) => !typeNode || c.id !== typeNode.id).flatMap(patternNames);
}

/** 函数参数按声明的类型记进 vars；`self` 由 scope.selfType 处理 */
export function declareRustParams(params: Node | null, scope: RustTypeScope, vars: RustVarTypes): void {
  for (const p of params?.namedChildren ?? []) {
    if (p.type !== 'parameter') continue;
    const pattern = p.childForFieldName('pattern');
    const type = rustTypePath(p.childForFieldName('type'), scope);
    const chain: RustTypeChain | null = type ? { root: { type }, fields: [] } : null;
    for (const n of patternNames(pattern)) vars.set(n, pattern?.type === 'identifier' ? chain : null);
  }
}

/** `let x: T = ..`、`let x = e` 记下类型；解构的变量推断不出，记为 null */
function declareLet(node: Node, scope: RustTypeScope, vars: RustVarTypes): void {
  const pattern = node.childForFieldName('pattern');
  if (pattern?.type !== 'identifier') {
    for (const n of patternNames(pattern)) vars.set(n, null);
    return;
  }
  const declared = rustTypePath(node.childForFieldName('type'), scope);
  const chain = declared ? { root: { type: declared }, fields: [] } : rustExprChain(node.childForFieldName('value'), scope, vars);
  vars.set(pattern.text, chain ?? null);
}

/** 节点自己引入的模式（闭包参数、for、if let / while let、match 分支）；变量只在这个节点里可见 */
function scopedPatterns(node: Node): (Node | null)[] {
  switch (node.type) {
    case 'closure_expression':
      return node.childForFieldName('parameters')?.namedChildren ?? [];
    case 'for_expression':
    case 'match_arm':
      return [node.childForFieldName('pattern')];
    case 'if_expression':
    case 'while_expression': {
      const cond = node.childForFieldName('condition');
      const lets = cond?.type === 'let_condition' ? [cond] : (cond?.descendantsOfType('let_condition') ?? []);
      return lets.map((l) => l?.childForFieldName('pattern') ?? null);
    }
    default:
      return [];
  }
}

/** 进入节点前把它的模式变量记为 null（遮住同名的外层变量和函数），返回被遮住的旧值，离开节点时用 restoreVars 恢复 */
function shadowPatternVars(node: Node, vars: RustVarTypes): Map<string, RustTypeChain | null | undefined> {
  const saved = new Map<string, RustTypeChain | null | undefined>();
  for (const p of scopedPatterns(node)) {
    for (const n of patternNames(p)) {
      if (!saved.has(n)) saved.set(n, vars.has(n) ? vars.get(n) : undefined);
      vars.set(n, null);
    }
  }
  return saved;
}

function restoreVars(vars: RustVarTypes, saved: ReadonlyMap<string, RustTypeChain | null | undefined>): void {
  for (const [n, v] of saved) {
    if (v === undefined) vars.delete(n);
    else vars.set(n, v);
  }
}

/** 函数体里不进入的节点：内层函数自己收集；内层 impl、trait、mod 的项不提取；宏参数不是语法树 */
const CALL_SKIP = new Set(['function_item', 'impl_item', 'trait_item', 'mod_item', 'macro_invocation', 'macro_definition']);

/** 收集调用点时的状态 */
interface CallWalk {
  callerId: string;
  scope: RustTypeScope;
  vars: RustVarTypes;
  out: RustCallSite[];
  /** 建了符号的闭包：起始位置 → 闭包符号 id，里面的调用记在闭包上 */
  closures?: ReadonlyMap<number, string>;
}

/** 一个调用表达式对应的调用点；被调的是局部变量、闭包或其他表达式时为 undefined */
function callSite(call: Node, w: CallWalk): RustCallSite | undefined {
  const fn = calleeNode(call);
  const mod = w.scope.mod.length > 0 ? { mod: w.scope.mod } : {};
  if (fn?.type === 'field_expression') {
    const name = fn.childForFieldName('field');
    if (name?.type !== 'field_identifier') return undefined;
    const chain = rustExprChain(fn.childForFieldName('value'), w.scope, w.vars);
    return { callerId: w.callerId, ...position(name), form: 'method', segments: [name.text], ...mod, ...(chain ? { receiverChain: chain } : {}) };
  }
  const segments = calleePath(fn, w.scope, w.vars);
  if (!fn || !segments) return undefined;
  return { callerId: w.callerId, ...position(lastSegmentNode(fn)), form: 'path', segments, ...mod };
}

function walkCalls(node: Node, w: CallWalk): void {
  if (CALL_SKIP.has(node.type)) return;
  if (node.type === 'call_expression') {
    const site = callSite(node, w);
    if (site) w.out.push(site);
  }
  const saved = shadowPatternVars(node, w.vars);
  const closureId = node.type === 'closure_expression' ? w.closures?.get(node.startIndex) : undefined;
  const caller = w.callerId;
  if (closureId) w.callerId = closureId;
  for (const c of node.namedChildren) walkCalls(c, w);
  w.callerId = caller;
  restoreVars(w.vars, saved);
  if (node.type === 'let_declaration') declareLet(node, w.scope, w.vars);
}

/**
 * 一个函数体里的调用点（不含内层函数里的），method 形式带上接收者的类型线索；
 * closures 里的闭包（起始位置 → 闭包符号 id）中的调用记在闭包符号上
 */
export function collectRustCalls(fn: Node, callerId: string, scope: RustTypeScope, closures?: ReadonlyMap<number, string>): RustCallSite[] {
  const body = fn.childForFieldName('body');
  if (!body) return [];
  const w: CallWalk = { callerId, scope, vars: new Map(), out: [], ...(closures ? { closures } : {}) };
  declareRustParams(fn.childForFieldName('parameters'), scope, w.vars);
  walkCalls(body, w);
  return w.out;
}
