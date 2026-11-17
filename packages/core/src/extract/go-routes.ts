import type { Node } from 'web-tree-sitter';
import { funcRef, type CallCollector, type CallVisitor } from './go-calls.js';
import { addFuncLiteral, type DeclWalk } from './go-decls.js';
import { goSelectorParts, goStringValue } from './go-syntax.js';
import { isImportName, ownValue, type GoTypeContext, type GoVarTypes } from './go-types.js';
import type { GoCobraCommand, GoHandlerRef, GoRoute } from './types.js';

/**
 * Go 入口的原始写法收集（提取时做）：net/http、gin、echo、chi 的路由注册和 cobra 命令，
 * 以及作为处理函数的函数字面量的符号。处理函数指向哪个符号在跨文件处理时确定（go-entries.ts）
 */

type Framework = GoRoute['framework'] | 'cobra';

const FRAMEWORK_PATHS: [Framework, RegExp][] = [
  ['net/http', /^net\/http$/],
  ['gin', /^github\.com\/gin-gonic\/gin$/],
  ['echo', /^github\.com\/labstack\/echo(\/v\d+)?$/],
  ['chi', /^github\.com\/go-chi\/chi(\/v\d+)?$/],
  ['cobra', /^github\.com\/spf13\/cobra$/],
];

const GIN_ECHO_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'Any']);
const CHI_METHODS = new Set(['Get', 'Post', 'Put', 'Delete', 'Patch', 'Head', 'Options', 'Connect', 'Trace']);
const HANDLE_FUNCS = new Set(['HandleFunc', 'Handle']);

/** 识别入口写法需要的文件信息 */
export interface RouteEnv {
  ctx: GoTypeContext;
  frameworks: ReadonlySet<Framework>;
}

/** 按文件的 import 判断用了哪些框架 */
export function routeEnv(ctx: GoTypeContext): RouteEnv {
  const paths = Object.values(ctx.imports);
  const frameworks = new Set(FRAMEWORK_PATHS.filter(([, re]) => paths.some((p) => re.test(p))).map(([fw]) => fw));
  return { ctx, frameworks };
}

/** 一次路由注册调用：receiver 为路由对象表达式（`http.HandleFunc` 时为 null） */
interface RouteCall {
  framework: GoRoute['framework'];
  method?: string;
  path?: Node;
  handler?: Node;
  receiver: Node | null;
}

function callArgs(call: Node): Node[] {
  return (call.childForFieldName('arguments')?.namedChildren ?? []).filter((n) => n.type !== 'comment');
}

/** `x.Name(...)` 的 x 和 Name */
function selectorParts(call: Node): { operand: Node; field: string } | undefined {
  return goSelectorParts(call.childForFieldName('function'));
}

/** 按 4.4 入口表识别路由注册：方法名、文件 import 的框架决定框架和处理函数是第几个参数 */
function routeCall(call: Node, env: RouteEnv, vars: GoVarTypes): RouteCall | undefined {
  const sel = selectorParts(call);
  if (!sel) return undefined;
  const { operand: receiver, field: name } = sel;
  const args = callArgs(call);
  const fw = env.frameworks;
  if (receiver.type === 'identifier' && isImportName(receiver.text, env.ctx, vars)) {
    const isHttp = env.ctx.imports[receiver.text] === 'net/http' && HANDLE_FUNCS.has(name);
    return isHttp ? { framework: 'net/http', path: args[0], handler: args[1], receiver: null } : undefined;
  }
  if (GIN_ECHO_METHODS.has(name) && fw.has('gin') && args.length >= 2) {
    return { framework: 'gin', method: name.toUpperCase(), path: args[0], handler: args[args.length - 1], receiver };
  }
  if (GIN_ECHO_METHODS.has(name) && fw.has('echo')) {
    return { framework: 'echo', method: name.toUpperCase(), path: args[0], handler: args[1], receiver };
  }
  if ((CHI_METHODS.has(name) || HANDLE_FUNCS.has(name)) && fw.has('chi')) {
    const method = CHI_METHODS.has(name) ? name.toUpperCase() : undefined;
    return { framework: 'chi', ...(method ? { method } : {}), path: args[0], handler: args[1], receiver };
  }
  if (HANDLE_FUNCS.has(name) && fw.has('net/http')) return { framework: 'net/http', path: args[0], handler: args[1], receiver };
  return undefined;
}

/** `&cobra.Command{Use: ..., RunE: h}` 的 Use 和处理函数（RunE 优先于 Run） */
function cobraCommand(lit: Node, env: RouteEnv, vars: GoVarTypes): { use: string; handler?: Node } | undefined {
  const type = lit.childForFieldName('type');
  if (!env.frameworks.has('cobra') || type?.type !== 'qualified_type' || type.childForFieldName('name')?.text !== 'Command') return undefined;
  const pkg = type.childForFieldName('package')?.text ?? '';
  if (!isImportName(pkg, env.ctx, vars) || ownValue(env.ctx.imports, pkg) !== 'github.com/spf13/cobra') return undefined;
  const fields = new Map<string, Node>();
  for (const el of lit.childForFieldName('body')?.namedChildren ?? []) {
    const value = el.type === 'keyed_element' ? el.childForFieldName('value')?.namedChildren[0] : undefined;
    if (value) fields.set(el.childForFieldName('key')?.text ?? '', value);
  }
  const use = fields.get('Use');
  return { use: goStringValue(use) ?? use?.text ?? '', handler: fields.get('RunE') ?? fields.get('Run') };
}

/** 去掉括号和 `http.HandlerFunc(f)` 这样的单参数转换 */
function unwrapHandler(node: Node): Node {
  if (node.type === 'parenthesized_expression' && node.namedChildren[0]) return unwrapHandler(node.namedChildren[0]);
  const args = node.type === 'call_expression' ? callArgs(node) : [];
  if (args.length === 1 && selectorParts(node)?.field === 'HandlerFunc') return unwrapHandler(args[0]!);
  return node;
}

// ---- 处理函数字面量的符号（建符号前，只看语法） ----

/** scopes 里作为处理函数的函数字面量的起始位置 */
function handlerLiteralStarts(scopes: Node[], env: RouteEnv): Set<number> {
  const out = new Set<number>();
  const vars: GoVarTypes = new Map();
  for (const n of scopes.flatMap((s) => s.descendantsOfType(['call_expression', 'composite_literal']))) {
    const h = n.type === 'call_expression' ? routeCall(n, env, vars)?.handler : cobraCommand(n, env, vars)?.handler;
    const lit = h ? unwrapHandler(h) : undefined;
    if (lit?.type === 'func_literal') out.add(lit.startIndex);
  }
  return out;
}

interface LiteralScope {
  outerQn: string;
  /** 本层函数字面量的名字前缀：外层里为 `func`，嵌套在 funcN 里为 `funcN.` */
  prefix: string;
  parent: number;
  handlers: Set<number>;
}

function numberLiterals(w: DeclWalk, node: Node, s: LiteralScope, counter: { n: number }): void {
  for (const child of node.namedChildren) {
    if (child.type !== 'func_literal') {
      numberLiterals(w, child, s, counter);
      continue;
    }
    const name = `${s.prefix}${++counter.n}`;
    let parent = s.parent;
    if (s.handlers.has(child.startIndex)) {
      parent = addFuncLiteral(w, child, `${s.outerQn}.${name}`, name, s.parent);
      w.literals.set(child.startIndex, parent);
    }
    numberLiterals(w, child, { ...s, prefix: `${name}.`, parent }, { n: 0 });
  }
}

/**
 * 给 scopes（一个函数声明，或全部包级变量声明）里作为处理函数的函数字面量建符号。
 * 编号和 Go 运行时一致：外层里第 N 个字面量为 funcN，嵌套在 funcN 里的第 M 个为 funcN.M；没建符号的字面量也占编号
 */
export function addHandlerLiterals(w: DeclWalk, scopes: Node[], outerQn: string, parent: number, env: RouteEnv): void {
  const handlers = handlerLiteralStarts(scopes, env);
  if (handlers.size === 0) return;
  const counter = { n: 0 };
  for (const scope of scopes) numberLiterals(w, scope, { outerQn, prefix: 'func', parent, handlers }, counter);
}

// ---- 按代码顺序收集路由（建符号后，和调用点一起遍历） ----

/** 收集结果，全部是普通对象 */
export interface RouteCollection {
  routes: GoRoute[];
  cobraCommands: GoCobraCommand[];
}

/** 路由前缀和路径拼接，去掉重复的 `/` */
export function joinRoute(prefix: string, path: string): string {
  if (!prefix) return path;
  if (!path) return prefix;
  return prefix.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`);
}

function literalText(node: Node | undefined): string {
  return goStringValue(node) ?? node?.text ?? '';
}

/** 一个函数里的路由收集状态：分组变量的前缀，处理函数字面量的符号 id */
class RouteVisitor implements CallVisitor {
  private readonly prefixes = new Map<string, string>();

  constructor(
    private readonly env: RouteEnv,
    private readonly literalIds: ReadonlyMap<number, string>,
    private readonly out: RouteCollection,
  ) {}

  enter(node: Node, c: CallCollector): (() => void) | undefined {
    if (node.type === 'func_literal') return this.enterLiteral(node, c);
    if (node.type === 'composite_literal') this.addCobra(node, c);
    if (node.type !== 'call_expression') return undefined;
    this.addRoute(node, c);
    return this.enterChiScope(node, c);
  }

  /** `g := r.Group("/api")`（gin、echo）记下 g 的前缀 */
  leave(node: Node, c: CallCollector): void {
    const pairs = assignedPairs(node);
    for (const [name, value] of pairs) {
      if (this.groupCall(value, c)) this.prefixes.set(name, this.prefixOf(value, c));
    }
  }

  /** 建了符号的处理函数字面量：里面的调用记到它自己 */
  private enterLiteral(node: Node, c: CallCollector): (() => void) | undefined {
    const id = this.literalIds.get(node.startIndex);
    if (!id) return undefined;
    const prev = c.callerId;
    c.callerId = id;
    return () => { c.callerId = prev; };
  }

  private handlerRef(node: Node | undefined, c: CallCollector): GoHandlerRef | undefined {
    const n = node ? unwrapHandler(node) : undefined;
    if (n?.type !== 'func_literal') return funcRef(n, c);
    const symbolId = this.literalIds.get(n.startIndex);
    return symbolId ? { symbolId } : undefined;
  }

  private addRoute(call: Node, c: CallCollector): void {
    const rc = routeCall(call, this.env, c.vars);
    const handler = this.handlerRef(rc?.handler, c);
    if (!rc || !handler) return;
    const raw = literalText(rc.path);
    const pattern = rc.framework === 'net/http' ? /^([A-Z]+)\s+(\S.*)$/.exec(raw) : null;
    const method = pattern ? pattern[1] : rc.method;
    const path = pattern ? pattern[2]! : joinRoute(rc.receiver ? this.prefixOf(rc.receiver, c) : '', raw);
    this.out.routes.push({ framework: rc.framework, ...(method ? { method } : {}), path, handler });
  }

  private addCobra(lit: Node, c: CallCollector): void {
    const cmd = cobraCommand(lit, this.env, c.vars);
    const handler = this.handlerRef(cmd?.handler, c);
    if (cmd && handler) this.out.cobraCommands.push({ use: cmd.use, handler });
  }

  /** chi 的 `r.Route("/api", func(r chi.Router) {...})`、`r.Group(func(r chi.Router) {...})`：字面量参数带上前缀，离开时恢复 */
  private enterChiScope(call: Node, c: CallCollector): (() => void) | undefined {
    const sel = selectorParts(call);
    if (!this.env.frameworks.has('chi') || (sel?.field !== 'Route' && sel?.field !== 'Group')) return undefined;
    const args = callArgs(call);
    const lit = args[args.length - 1];
    const param = lit?.type === 'func_literal' ? lit.childForFieldName('parameters')?.namedChildren[0]?.childForFieldName('name')?.text : undefined;
    if (!param) return undefined;
    const base = this.prefixOf(sel.operand, c);
    const prev = this.prefixes.get(param);
    this.prefixes.set(param, sel.field === 'Route' ? joinRoute(base, literalText(args[0])) : base);
    return () => { if (prev === undefined) this.prefixes.delete(param); else this.prefixes.set(param, prev); };
  }

  /** gin、echo 的 `x.Group("/api", ...)` */
  private groupCall(node: Node, c: CallCollector): { receiver: Node; path: string } | undefined {
    if (node.type !== 'call_expression' || !(this.env.frameworks.has('gin') || this.env.frameworks.has('echo'))) return undefined;
    const sel = selectorParts(node);
    const path = goStringValue(callArgs(node)[0]);
    if (sel?.field !== 'Group' || path === undefined || isImportName(sel.operand.text, this.env.ctx, c.vars)) return undefined;
    return { receiver: sel.operand, path };
  }

  /** 路由对象表达式的前缀：分组变量，或直接写的 `r.Group("/api")` */
  private prefixOf(expr: Node, c: CallCollector): string {
    if (expr.type === 'identifier') return this.prefixes.get(expr.text) ?? '';
    const group = this.groupCall(expr, c);
    return group ? joinRoute(this.prefixOf(group.receiver, c), group.path) : '';
  }
}

/** 赋值和声明里左边的变量名和右边的表达式，按位置对应 */
function assignedPairs(node: Node): [string, Node][] {
  let names: Node[] = [];
  let values: Node[] = [];
  if (node.type === 'short_var_declaration' || node.type === 'assignment_statement') {
    names = node.childForFieldName('left')?.namedChildren ?? [];
    values = node.childForFieldName('right')?.namedChildren ?? [];
  } else if (node.type === 'var_spec') {
    names = node.childrenForFieldName('name');
    values = node.childForFieldName('value')?.namedChildren ?? [];
  }
  if (names.length !== values.length) return [];
  return names.flatMap((n, i): [string, Node][] => (n.type === 'identifier' ? [[n.text, values[i]!]] : []));
}

/** 一个函数（或包级变量初始化）的路由收集器，和调用点收集一起遍历 */
export function routeVisitor(env: RouteEnv, literalIds: ReadonlyMap<number, string>, out: RouteCollection): CallVisitor {
  return new RouteVisitor(env, literalIds, out);
}
