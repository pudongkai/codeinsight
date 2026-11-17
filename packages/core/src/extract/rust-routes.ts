import type { Node } from 'web-tree-sitter';
import { joinRoute } from './go-routes.js';
import { rustCrateName } from './rust-cargo.js';
import { descendantsSkipping } from './rust-facts.js';
import { attributeArgs, attributePath, itemAttributes, rustPathOf, rustStringValue } from './rust-syntax.js';
import { calleeNode, scopedPath, type RustTypeScope } from './rust-types.js';
import type { RustMount, RustPathRef, RustRoute } from './types.js';

/**
 * Rust 入口的原始写法收集（提取时做）：axum、actix-web 的链式路由注册，actix-web、rocket 的属性路由，
 * rocket 的 mount 前缀，clap 子命令名。处理函数指向哪个符号在跨文件处理时确定（rust-entries.ts）
 */

type Framework = RustRoute['framework'];

/** 文件所在包依赖的框架；actix-web 和 rocket 的属性写法相同，attrFramework 为属性路由所属的框架 */
export interface RustRouteEnv {
  frameworks: ReadonlySet<Framework | 'clap'>;
  attrFramework?: 'actix-web' | 'rocket';
}

const DEP_FRAMEWORKS: [string, Framework | 'clap'][] = [['axum', 'axum'], ['actix_web', 'actix-web'], ['rocket', 'rocket'], ['clap', 'clap']];

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);

/** 两个都依赖时按文件里出现的路径第一段（含 use）判断，都出现或都没出现时不识别属性路由 */
function attrFramework(frameworks: ReadonlySet<string>, pathRoots: readonly string[]): RustRouteEnv['attrFramework'] {
  const actix = frameworks.has('actix-web');
  const rocket = frameworks.has('rocket');
  if (actix && rocket) {
    const a = pathRoots.includes('actix_web');
    if (a === pathRoots.includes('rocket')) return undefined;
    return a ? 'actix-web' : 'rocket';
  }
  if (actix) return 'actix-web';
  return rocket ? 'rocket' : undefined;
}

/** 按包的依赖名（`-` 换成 `_` 后比较）判断用了哪些框架 */
export function rustRouteEnv(deps: readonly string[], pathRoots: readonly string[]): RustRouteEnv {
  const names = new Set(deps.map(rustCrateName));
  const frameworks = new Set(DEP_FRAMEWORKS.filter(([dep]) => names.has(dep)).map(([, fw]) => fw));
  return { frameworks, attrFramework: attrFramework(frameworks, pathRoots) };
}

function callArgs(call: Node): Node[] {
  return (call.childForFieldName('arguments')?.namedChildren ?? []).filter((n) => n.type !== 'line_comment' && n.type !== 'block_comment');
}

function lastSegment(node: Node | null): string | undefined {
  return node ? rustPathOf(node)?.at(-1) : undefined;
}

// ---- 属性路由 ----

/** 属性参数里第一个字符串字面量 */
function firstString(args: string): string | undefined {
  const m = /"((?:[^"\\]|\\.)*)"/.exec(args);
  return m?.[1];
}

/** `#[route("/p", method = "GET")]`（actix-web）、`#[route(GET, uri = "/p")]`（rocket）的方法 */
function routeAttrMethod(args: string): string | undefined {
  const m = /method\s*=\s*"([A-Za-z]+)"/.exec(args) ?? /^\(\s*([A-Za-z]+)\s*,/.exec(args);
  return m?.[1]?.toUpperCase();
}

/** 函数上的 `#[get("/p")]`、`#[route(..)]` 属性；env 没有属性路由框架或不是路由属性时为 undefined */
export function rustAttrRoute(fn: Node, env: RustRouteEnv): Omit<RustRoute, 'handler'> | undefined {
  if (!env.attrFramework) return undefined;
  for (const a of itemAttributes(fn)) {
    const name = attributePath(a).split('::').pop() ?? '';
    const args = attributeArgs(a);
    const path = firstString(args);
    if (path === undefined) continue;
    if (HTTP_METHODS.has(name)) return { framework: env.attrFramework, method: name.toUpperCase(), path };
    if (name === 'route') {
      const method = routeAttrMethod(args);
      return { framework: env.attrFramework, ...(method ? { method } : {}), path };
    }
  }
  return undefined;
}

// ---- 链式路由 ----

/** 收集中的路由：处理函数为路径，或还没建符号的闭包节点 */
export interface PendingRoute extends Omit<RustRoute, 'handler'> {
  handler: RustPathRef | { closure: Node };
}

/** 一个函数体的收集结果 */
export interface FnRouteCollection {
  routes: PendingRoute[];
  mounts: RustMount[];
  clapCommands: string[];
}

interface RouteWalk {
  env: RustRouteEnv;
  scope: RustTypeScope;
  out: FnRouteCollection;
}

/** 表达式的值带着的路由前缀；resource 为 actix-web 的 `web::resource(..)` */
interface Carried {
  prefix: string;
  resource: boolean;
}

/** 函数体里不进入的节点：内层函数自己收集，内层 impl、trait、mod 的项不提取 */
const ROUTE_SKIP = new Set(['function_item', 'impl_item', 'trait_item', 'mod_item', 'macro_definition']);

const AXUM_METHODS = new Set([...HTTP_METHODS, 'any']);

function handlerRef(node: Node | undefined, w: RouteWalk): PendingRoute['handler'] | undefined {
  let n = node;
  while (n?.type === 'parenthesized_expression') n = n.namedChildren[0];
  if (!n) return undefined;
  if (n.type === 'closure_expression') return { closure: n };
  const p = rustPathOf(n);
  const segments = p && scopedPath(p, w.scope);
  if (!segments) return undefined;
  return w.scope.mod.length > 0 ? { segments, mod: w.scope.mod } : { segments };
}

function pushRoute(w: RouteWalk, framework: Framework, method: string | undefined, path: string, handlerNode: Node | undefined): void {
  const handler = handlerRef(handlerNode, w);
  if (handler) w.out.routes.push({ framework, ...(method ? { method } : {}), path, handler });
}

/**
 * axum 的方法路由 `get(h).post(h2)`：各方法和处理函数；链上的其他方法（`.layer(x)`、`.with_state(s)`）跳过。
 * 不是方法路由时为空
 */
function axumMethods(expr: Node | undefined): { method?: string; handler: Node | undefined }[] {
  if (expr?.type !== 'call_expression') return [];
  const fn = calleeNode(expr);
  const args = callArgs(expr);
  if (fn?.type === 'field_expression') {
    const name = fn.childForFieldName('field')?.text ?? '';
    const base = axumMethods(fn.childForFieldName('value') ?? undefined);
    return base.length > 0 && AXUM_METHODS.has(name) ? [...base, { method: axumMethod(name), handler: args[0] }] : base;
  }
  const name = lastSegment(fn) ?? '';
  return AXUM_METHODS.has(name) && args.length === 1 ? [{ method: axumMethod(name), handler: args[0] }] : [];
}

function axumMethod(name: string): string | undefined {
  return name === 'any' ? undefined : name.toUpperCase();
}

/** actix-web 的 `web::get().to(h)`、`web::route().to(h)`（中间可以有 `.guard(..)` 等） */
function actixRoute(expr: Node | undefined): { method?: string; handler: Node | undefined } | undefined {
  const fn = expr?.type === 'call_expression' ? calleeNode(expr) : null;
  if (fn?.type !== 'field_expression' || fn.childForFieldName('field')?.text !== 'to') return undefined;
  let base = fn.childForFieldName('value');
  while (base?.type === 'call_expression' && calleeNode(base)?.type === 'field_expression') base = calleeNode(base)!.childForFieldName('value');
  const name = base?.type === 'call_expression' ? lastSegment(calleeNode(base)) : undefined;
  if (name !== 'route' && !HTTP_METHODS.has(name ?? '')) return undefined;
  return { ...(name !== 'route' ? { method: name!.toUpperCase() } : {}), handler: callArgs(expr!)[0] };
}

/** `routes![a, b::c]` 里的路径 */
function routesMacroPaths(node: Node | undefined, w: RouteWalk): RustPathRef[] {
  if (node?.type !== 'macro_invocation' || lastSegment(node.childForFieldName('macro')) !== 'routes') return [];
  const tokens = node.namedChildren.find((c) => c.type === 'token_tree')?.text.slice(1, -1) ?? '';
  const out: RustPathRef[] = [];
  for (const item of tokens.split(',')) {
    const segments = item.split('::').map((s) => s.trim());
    if (segments.some((s) => !/^[A-Za-z_]\w*$/.test(s))) continue;
    const full = scopedPath(segments, w.scope);
    if (full) out.push(w.scope.mod.length > 0 ? { segments: full, mod: w.scope.mod } : { segments: full });
  }
  return out;
}

/** `x.route(..)`、`x.nest(..)` 等路由方法；不是路由方法时为 undefined */
function routeMethod(name: string, recv: Carried, args: Node[], w: RouteWalk): Carried | undefined {
  const fw = w.env.frameworks;
  const path = rustStringValue(args[0]);
  if (name === 'route' && args.length === 2 && path !== undefined) {
    const full = joinRoute(recv.prefix, path);
    const axum = fw.has('axum') ? axumMethods(args[1]) : [];
    for (const m of axum) pushRoute(w, 'axum', m.method, full, m.handler);
    const actix = axum.length === 0 && fw.has('actix-web') ? actixRoute(args[1]) : undefined;
    if (actix) pushRoute(w, 'actix-web', actix.method, full, actix.handler);
    if (axum.length > 0 || actix) return recv;
  }
  if (name === 'nest' && fw.has('axum') && args.length === 2 && path !== undefined) {
    evalNode(args[1]!, joinRoute(recv.prefix, path), w);
    return recv;
  }
  return actixMethod(name, recv, args, w) ?? rocketMount(name, recv, args, w);
}

/** actix-web 的 `resource.route(web::get().to(h))`、`resource.to(h)`、`scope.service(..)` */
function actixMethod(name: string, recv: Carried, args: Node[], w: RouteWalk): Carried | undefined {
  if (!w.env.frameworks.has('actix-web') || args.length !== 1) return undefined;
  if (name === 'route' && recv.resource) {
    const r = actixRoute(args[0]);
    if (r) pushRoute(w, 'actix-web', r.method, recv.prefix, r.handler);
    return recv;
  }
  if (name === 'to' && recv.resource) {
    pushRoute(w, 'actix-web', undefined, recv.prefix, args[0]);
    return recv;
  }
  if (name === 'service') {
    evalNode(args[0]!, recv.prefix, w);
    return recv;
  }
  return undefined;
}

function rocketMount(name: string, recv: Carried, args: Node[], w: RouteWalk): Carried | undefined {
  const prefix = rustStringValue(args[0]);
  if (name !== 'mount' || !w.env.frameworks.has('rocket') || args.length !== 2 || prefix === undefined) return undefined;
  const handlers = routesMacroPaths(args[1], w);
  if (handlers.length > 0) w.out.mounts.push({ prefix, handlers });
  return recv;
}

/** `Command::new("x")` 是 `.subcommand(..)` / `.subcommands(..)` 的参数时为子命令名 */
function clapCommand(call: Node, w: RouteWalk): void {
  const p = rustPathOf(calleeNode(call));
  if (!w.env.frameworks.has('clap') || !p || p.length < 2 || p.at(-2) !== 'Command' || p.at(-1) !== 'new') return;
  const name = rustStringValue(callArgs(call)[0]);
  let up = call.parent;
  while (up && up.type !== 'arguments') up = up.parent;
  const owner = up?.parent ? calleeNode(up.parent) : null;
  const method = owner?.type === 'field_expression' ? owner.childForFieldName('field')?.text : undefined;
  if (name && (method === 'subcommand' || method === 'subcommands')) w.out.clapCommands.push(name);
}

/** 路径形式的调用：actix-web 的 `web::scope("/api")`、`web::resource("/p")` 带上前缀 */
function pathCall(call: Node, prefix: string, w: RouteWalk): Carried {
  const args = callArgs(call);
  for (const a of args) evalNode(a, prefix, w);
  clapCommand(call, w);
  const name = lastSegment(calleeNode(call));
  const path = rustStringValue(args[0]);
  if (!w.env.frameworks.has('actix-web') || path === undefined) return { prefix, resource: false };
  if (name === 'scope') return { prefix: joinRoute(prefix, path), resource: false };
  if (name === 'resource') return { prefix: joinRoute(prefix, path), resource: true };
  return { prefix, resource: false };
}

/** 方法调用：先算接收者，路由方法按框架处理，其他方法的值沿用接收者的前缀（构建器链） */
function evalCall(call: Node, prefix: string, w: RouteWalk): Carried {
  const fn = calleeNode(call);
  if (fn?.type !== 'field_expression') return pathCall(call, prefix, w);
  const value = fn.childForFieldName('value');
  const recv = value ? evalNode(value, prefix, w) : { prefix, resource: false };
  const args = callArgs(call);
  const handled = routeMethod(fn.childForFieldName('field')?.text ?? '', recv, args, w);
  if (handled) return handled;
  for (const a of args) evalNode(a, prefix, w);
  return recv;
}

function evalNode(node: Node, prefix: string, w: RouteWalk): Carried {
  if (ROUTE_SKIP.has(node.type)) return { prefix, resource: false };
  if (node.type === 'call_expression') return evalCall(node, prefix, w);
  for (const c of node.namedChildren) evalNode(c, prefix, w);
  return { prefix, resource: false };
}

/** 一个函数体里的链式路由、rocket mount 和 clap builder 子命令 */
export function collectFnRoutes(fn: Node, scope: RustTypeScope, env: RustRouteEnv): FnRouteCollection {
  const out: FnRouteCollection = { routes: [], mounts: [], clapCommands: [] };
  const body = fn.childForFieldName('body');
  if (body && env.frameworks.size > 0) evalNode(body, '', { env, scope, out });
  return out;
}

const CLOSURE = new Set(['closure_expression']);

/** 函数体里的闭包，按出现顺序（不进入内层函数和 impl、trait、mod） */
export function fnClosures(fn: Node): Node[] {
  const body = fn.childForFieldName('body');
  return body ? descendantsSkipping(body, CLOSURE, ROUTE_SKIP) : [];
}

// ---- clap derive ----

/** 驼峰名转 clap 默认的子命令名：`AddUser` → `add-user` */
function kebabCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();
}

/** `#[command(name = "x")]`、`#[clap(name = "x")]` 指定的名字 */
function explicitName(variant: Node): string | undefined {
  for (const a of itemAttributes(variant)) {
    if (!['command', 'clap'].includes(attributePath(a))) continue;
    const m = /\bname\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(attributeArgs(a));
    if (m) return m[1];
  }
  return undefined;
}

/** `#[derive(Subcommand)]` 的 enum 各变体对应的子命令名 */
export function clapVariantNames(enumItem: Node): string[] {
  const body = enumItem.childForFieldName('body');
  return (body?.namedChildren ?? [])
    .filter((v) => v.type === 'enum_variant')
    .map((v) => explicitName(v) ?? kebabCase(v.childForFieldName('name')?.text ?? ''))
    .filter(Boolean);
}
