import type { Node } from 'web-tree-sitter';
import { canonicalRustPath, pathSegments, rustStringValue, stripRaw } from './rust-syntax.js';
import type { RustFileFacts, RustPosition, RustUseScope } from './types.js';

const USE_DECL = ['use_declaration'];

/** `use` 展开后的一项 */
export interface RustUseItem {
  /** 绑定的名字：别名或路径最后一段；glob 为模块路径最后一段 */
  name: string;
  /** 完整路径；`use a::{self}` 为 a 的路径 */
  path: string[];
  /** `use x::*` */
  glob: boolean;
  /** `pub use`（`pub(crate)` 等受限可见性不算） */
  pub: boolean;
  /** 路径最后一段的位置；glob 为 `*` 前面那一段的位置 */
  leaf: RustPosition;
  /** use 声明所在的内联 mod（相对文件模块）；不在内联 mod 里时为空数组 */
  mod: string[];
  /** 写在函数体里时为最近那个函数的起始位置（startIndex）；只对该函数和它里面的函数生效 */
  fnStart?: number;
  /** 写在函数体里定义的 mod 里：这类 mod 的项不提取，它的 use 不进任何绑定 */
  inFnMod?: true;
}

/** 展开时还不知道所在内联 mod 的一项 */
type RawUseItem = Omit<RustUseItem, 'mod' | 'fnStart' | 'inFnMod'>;

export function position(n: Node): RustPosition {
  return { line: n.startPosition.row, col: n.startPosition.column };
}

/** 路径节点最后一段所在的节点 */
export function lastSegmentNode(n: Node): Node {
  return n.childForFieldName('name') ?? n;
}

/** 处理一个 use 树节点，展开结果追加到 out */
function expandUseTree(n: Node, prefix: string[], pub: boolean, out: RawUseItem[]): void {
  switch (n.type) {
    case 'scoped_use_list': {
      const p = n.childForFieldName('path');
      const next = [...prefix, ...pathSegments(p)];
      for (const c of n.childForFieldName('list')?.namedChildren ?? []) expandUseTree(c, next, pub, out);
      return;
    }
    case 'use_list':
      for (const c of n.namedChildren) expandUseTree(c, prefix, pub, out);
      return;
    case 'use_as_clause': {
      const p = n.childForFieldName('path');
      if (!p) return;
      const path = [...prefix, ...pathSegments(p)];
      out.push({ name: stripRaw(n.childForFieldName('alias')?.text ?? path[path.length - 1] ?? ''), path, glob: false, pub, leaf: position(lastSegmentNode(p)) });
      return;
    }
    case 'use_wildcard': {
      const p = n.namedChildren[0];
      const path = [...prefix, ...pathSegments(p ?? null)];
      out.push({ name: path[path.length - 1] ?? '', path, glob: true, pub, leaf: position(p ? lastSegmentNode(p) : n) });
      return;
    }
    default:
      expandUsePath(n, prefix, pub, out);
  }
}

/** 普通路径（含 use_list 里的 `self`） */
function expandUsePath(n: Node, prefix: string[], pub: boolean, out: RawUseItem[]): void {
  if (n.type === 'self' && prefix.length > 0) {
    out.push({ name: prefix[prefix.length - 1]!, path: prefix, glob: false, pub, leaf: position(n) });
    return;
  }
  const path = [...prefix, ...pathSegments(n)];
  if (path.length > 0) out.push({ name: path[path.length - 1]!, path, glob: false, pub, leaf: position(lastSegmentNode(n)) });
}

/** 节点下（含自身）所有指定类型的节点，先序遍历；skip 里的类型不进入 */
export function descendantsSkipping(root: Node, types: ReadonlySet<string>, skip: ReadonlySet<string>): Node[] {
  const out: Node[] = [];
  const visit = (n: Node): void => {
    if (types.has(n.type)) out.push(n);
    if (skip.has(n.type)) return;
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return out;
}

/** 文件里所有 use 声明（含内联 mod 和函数体里的）展开后的各项 */
export function expandRustUses(root: Node): RustUseItem[] {
  const out: RustUseItem[] = [];
  for (const decl of root.descendantsOfType(USE_DECL)) {
    const arg = decl.childForFieldName('argument');
    const vis = decl.namedChildren.find((c) => c.type === 'visibility_modifier');
    const items: RawUseItem[] = [];
    if (arg) expandUseTree(arg, [], vis?.text === 'pub', items);
    const mod = inlineModPath(decl);
    const fn = enclosingFunction(decl);
    const inFnMod = !fn && hasAncestor(decl, 'function_item');
    out.push(...items.map((u) => ({ ...u, mod, ...(fn ? { fnStart: fn.startIndex } : {}), ...(inFnMod ? { inFnMod: true as const } : {}) })));
  }
  return out;
}

/** 最近的外层函数；中间隔着内联 mod 时为 undefined（mod 里的项不在函数的作用域里） */
function enclosingFunction(node: Node): Node | undefined {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'function_item') return p;
    if (p.type === 'mod_item') return undefined;
  }
  return undefined;
}

function hasAncestor(node: Node, type: string): boolean {
  for (let p = node.parent; p; p = p.parent) if (p.type === type) return true;
  return false;
}

/** 节点所在的内联 mod 名字（从外到内） */
export function inlineModPath(node: Node): string[] {
  const out: string[] = [];
  for (let p = node.parent; p; p = p.parent) {
    const name = p.type === 'mod_item' ? p.childForFieldName('name') : null;
    if (name) out.unshift(stripRaw(name.text));
  }
  return out;
}

/** 一组 use 加进绑定：`self`/`super` 开头的换成 `crate` 开头，换不了的（`super` 超出 crate 根）丢弃；`_` 绑定不记 */
function addBindings(out: RustUseScope, uses: readonly RustUseItem[], modulePath: readonly string[]): RustUseScope {
  for (const u of uses) {
    const full = canonicalRustPath(u.path, [...modulePath, ...u.mod]);
    if (!full || full.length === 0) continue;
    if (u.glob) out.globUses.push(full);
    else if (u.name !== '_') {
      out.uses[u.name] = full;
      if (u.pub) out.pubUses[u.name] = full;
    }
  }
  return out;
}

const emptyScope = (): RustUseScope => ({ uses: {}, globUses: [], pubUses: {} });

/**
 * use 展开结果转成 use 绑定：文件模块里的 use 为 uses/globUses/pubUses，内联 mod 里的按 mod 路径（`::` 连接）
 * 记进 modUses；函数体里的不在其中（见 rustFnUseBindings）
 */
export function rustUseBindings(uses: readonly RustUseItem[], modulePath: readonly string[]): RustUseScope & Pick<RustFileFacts, 'modUses'> {
  const byMod = new Map<string, RustUseItem[]>();
  for (const u of uses) {
    if (u.fnStart !== undefined || u.inFnMod) continue;
    const k = u.mod.join('::');
    byMod.set(k, [...(byMod.get(k) ?? []), u]);
  }
  const top = addBindings(emptyScope(), byMod.get('') ?? [], modulePath);
  const modUses: Record<string, RustUseScope> = {};
  for (const [k, items] of byMod) if (k !== '') modUses[k] = addBindings(emptyScope(), items, modulePath);
  return { ...top, ...(Object.keys(modUses).length > 0 ? { modUses } : {}) };
}

/** 函数体里的 use 绑定（名字 → 完整路径），fnStarts 为该函数和它外层函数的起始位置；glob 不记 */
export function rustFnUseBindings(uses: readonly RustUseItem[], fnStarts: ReadonlySet<number>, modulePath: readonly string[]): Record<string, string[]> {
  const items = uses.filter((u) => u.fnStart !== undefined && fnStarts.has(u.fnStart) && !u.glob);
  return addBindings(emptyScope(), items, modulePath).uses;
}

/** use 声明所在的行区间（0 起始，含两端） */
export function rustUseRows(root: Node): [number, number][] {
  return root.descendantsOfType(USE_DECL).map((d) => [d.startPosition.row, d.endPosition.row]);
}

const SCOPED = new Set(['scoped_identifier', 'scoped_type_identifier', 'token_tree']);

const GENERIC_PATHS = new Set(['generic_type', 'generic_type_with_turbofish']);

/** 路径节点最左边一段的文字；`Vec::<u8>::new` 这样带泛型参数的段取类型名 */
function leftmost(n: Node): string | undefined {
  let cur: Node = n;
  for (;;) {
    const next = GENERIC_PATHS.has(cur.type) ? cur.childForFieldName('type') : cur.childForFieldName('path');
    if (!next) break;
    cur = next;
  }
  if (cur.type === 'scoped_identifier' || cur.type === 'scoped_type_identifier') return cur.childForFieldName('name')?.text;
  return cur.text.split(/[<\s:]/)[0];
}

/** token_tree 里紧跟 `::`、前面不是 `::` 的标识符（宏参数和属性参数里的路径开头） */
function tokenTreeRoots(tree: Node, out: Set<string>): void {
  for (let i = 0; i < tree.childCount; i++) {
    const c = tree.child(i)!;
    if (c.type !== 'identifier' || tree.child(i + 1)?.type !== '::' || tree.child(i - 1)?.type === '::') continue;
    out.add(stripRaw(c.text));
  }
}

/**
 * 多段路径的第一段（去重、排序）：路径表达式和类型路径、宏路径、属性路径、宏和属性参数里的路径，以及 use 路径
 * （`use reqwest;` 这样的单段 use 也算）
 */
export function collectRustPathRoots(root: Node, uses: readonly RustUseItem[] = expandRustUses(root)): string[] {
  const out = new Set<string>();
  for (const n of descendantsSkipping(root, SCOPED, new Set(USE_DECL))) {
    if (n.type === 'token_tree') {
      tokenTreeRoots(n, out);
      continue;
    }
    const first = leftmost(n);
    if (first) out.add(stripRaw(first));
  }
  for (const u of uses) if (u.path[0]) out.add(u.path[0]);
  return [...out].sort();
}

const ENV_FUNCS = new Set(['std::env::var', 'std::env::var_os', 'dotenvy::var', 'dotenv::var']);
const ENV_MACROS = new Set(['env', 'option_env', 'std::env', 'std::option_env', 'core::env', 'core::option_env']);
const ENV_NODES = ['call_expression', 'macro_invocation'];

/** 调用的路径按 use 绑定展开第一段 */
function expandedPath(segments: string[], bindings: ReadonlyMap<string, string[]>): string {
  const head = segments[0] !== undefined ? bindings.get(segments[0]) : undefined;
  return (head ? [...head, ...segments.slice(1)] : segments).join('::');
}

function envCallName(n: Node, bindings: ReadonlyMap<string, string[]>): string | undefined {
  const fn = n.childForFieldName('function');
  if (fn?.type !== 'identifier' && fn?.type !== 'scoped_identifier') return undefined;
  if (!ENV_FUNCS.has(expandedPath(pathSegments(fn), bindings))) return undefined;
  return rustStringValue(n.childForFieldName('arguments')?.namedChildren[0]);
}

/**
 * 宏参数（token_tree）里的环境变量读取：`a::b("X")` 形式的调用和 `env!("X")` 这类宏；
 * token_tree 不是语法树，按 token 序列匹配，嵌套的逐层看
 */
function envReadsInTokens(tree: Node, bindings: ReadonlyMap<string, string[]>, out: Set<string>): void {
  let path: string[] = [];
  let envMacro = false;
  for (let i = 0; i < tree.childCount; i++) {
    const c = tree.child(i)!;
    if (c.type === 'identifier') {
      path = tree.child(i - 1)?.type === '::' ? [...path, c.text] : [c.text];
      continue;
    }
    if (c.type === 'token_tree') {
      const isRead = envMacro || (path.length > 0 && ENV_FUNCS.has(expandedPath(path, bindings)));
      const name = isRead ? rustStringValue(c.namedChildren[0]) : undefined;
      if (name) out.add(name);
      envReadsInTokens(c, bindings, out);
    }
    envMacro = c.type === '!' && ENV_MACROS.has(path.join('::'));
    if (c.type !== '::') path = [];
  }
}

function envMacroName(n: Node): string | undefined {
  const name = n.childForFieldName('macro')?.text.replace(/\s+/g, '');
  if (!name || !ENV_MACROS.has(name)) return undefined;
  const tree = n.namedChildren.find((c) => c.type === 'token_tree');
  return rustStringValue(tree?.namedChildren[0]);
}

/**
 * 环境变量读取的字面量参数（去重，按出现顺序）：`std::env::var`/`var_os`、经 use 导入后的 `env::var`/`var`、
 * `dotenvy::var`（含写在其他宏参数里的），以及 `env!`、`option_env!`
 */
export function collectRustEnvReads(root: Node, uses: readonly RustUseItem[] = expandRustUses(root)): string[] {
  const bindings = new Map(uses.filter((u) => !u.glob).map((u) => [u.name, u.path] as const));
  const out = new Set<string>();
  for (const n of root.descendantsOfType(ENV_NODES)) {
    const name = n.type === 'call_expression' ? envCallName(n, bindings) : envMacroName(n);
    if (name) out.add(name);
    const args = n.type === 'macro_invocation' ? n.namedChildren.find((c) => c.type === 'token_tree') : undefined;
    if (args && !name) envReadsInTokens(args, bindings, out);
  }
  return [...out];
}

const ITEM_CONTAINERS = new Set(['source_file', 'declaration_list']);

/** 项级的宏调用：直接在文件或 mod 里，或像 `thread_local!(..);` 那样包在项级的 expression_statement 里 */
function isItemLevel(n: Node): boolean {
  const parent = n.parent;
  if (parent?.type === 'expression_statement') return ITEM_CONTAINERS.has(parent.parent?.type ?? '');
  return ITEM_CONTAINERS.has(parent?.type ?? '');
}
const MACRO_OR_MOD = ['macro_invocation', 'mod_item'];

/** 项级宏调用的行范围和 `mod x;` 声明所在行 */
export function collectRustMacrosAndMods(root: Node): { macroRanges: [number, number][]; modDecls: number[] } {
  const macroRanges: [number, number][] = [];
  const modDecls: number[] = [];
  for (const n of root.descendantsOfType(MACRO_OR_MOD)) {
    if (n.type === 'mod_item' && !n.childForFieldName('body')) modDecls.push(n.startPosition.row);
    else if (n.type === 'macro_invocation' && isItemLevel(n)) macroRanges.push([n.startPosition.row, n.endPosition.row]);
  }
  return { macroRanges, modDecls };
}

/** 只认 `pub`；`pub(crate)`、`pub(super)` 等受限可见性不算 */
function isPlainPub(item: Node): boolean {
  return item.namedChildren.some((c) => c.type === 'visibility_modifier' && c.text === 'pub');
}

/**
 * 文件里对外公开的内联 mod（相对文件模块的路径，用 `::` 连接）：它和包着它的内联 mod 都是 `pub`。
 * 函数体里的 mod 不算
 */
export function collectRustPublicMods(root: Node): string[] {
  const out: string[] = [];
  const walk = (container: Node, prefix: string[]): void => {
    for (const item of container.namedChildren) {
      if (item.type !== 'mod_item' || !isPlainPub(item)) continue;
      const body = item.childForFieldName('body');
      const name = item.childForFieldName('name');
      if (!body || !name) continue;
      const path = [...prefix, stripRaw(name.text)];
      out.push(path.join('::'));
      walk(body, path);
    }
  };
  walk(root, []);
  return out;
}
