import path from 'node:path';
import type { Node, Parser } from 'web-tree-sitter';
import type { SymbolRow } from '../model/types.js';
import { sha1 } from '../util/hash.js';
import { normalizeTokens, RUST_TOKENS } from './normalize.js';
import type { FileFlags } from './python.js';
import { rustFileUnit, type RustPackage, type RustFileUnit } from './rust-cargo.js';
import {
  collectRustEnvReads, collectRustMacrosAndMods, collectRustPathRoots, expandRustUses, rustFnUseBindings, rustUseBindings, rustUseRows,
  type RustUseItem,
} from './rust-facts.js';
import {
  attributeArgs, attributePath, implTypeName, isCfgTest, isTestAttribute, itemAttributes, normalizeTraitText, rustDocComment,
  rustHead, rustModuleDoc, stripRaw,
} from './rust-syntax.js';
import { finalizeSymbols, restoredSymbols, type RawSymbol } from './symbols.js';
import { clapVariantNames, collectFnRoutes, fnClosures, rustAttrRoute, rustRouteEnv, type RustRouteEnv } from './rust-routes.js';
import { collectRustCalls, rustBounds, rustFnResult, rustImplTypePath, rustStructFields, type RustTypeScope } from './rust-types.js';
import type { ExtractedFile, ExtractedSymbol, RustDerives, RustFileFacts, RustMount, RustPathRef, RustRoute } from './types.js';

/** 收集中的路由：处理函数为路径，或 out 里的下标（带路由属性的函数、作为处理函数的闭包） */
type WalkRoute = Omit<RustRoute, 'handler'> & { handler: RustPathRef | { idx: number } };

/** 遍历项时的状态 */
interface RustWalk {
  path: string;
  source: string;
  flags: FileFlags;
  out: RawSymbol[];
  /** 类型的 qualifiedName → out 里的下标 */
  types: Map<string, number>;
  /** impl 方法在 out 里的下标 → 目标类型的 qualifiedName，遍历完后据此定父符号 */
  implOwners: Map<number, string>;
  /** 类型在 out 里的下标 → derive 和属性 */
  derives: Map<number, RustDerives>;
  /** 文件的模块路径 */
  modulePath: string[];
  /** 函数和方法：out 里的下标、语法节点、类型上下文；遍历完后收集调用点和返回类型 */
  fns: { idx: number; node: Node; scope: RustTypeScope }[];
  /** struct：out 里的下标、语法节点、类型上下文；遍历完后收集字段类型 */
  structs: { idx: number; node: Node; scope: RustTypeScope }[];
  /** impl 方法在 out 里的下标 → impl 目标类型的路径 */
  implTypes: Map<number, RustPathRef>;
  /** 内联 mod 的路径（相对文件模块） */
  inlineMods: string[][];
  /** 文件里所有 use 展开后的项；函数体里的按所在函数取 */
  uses: readonly RustUseItem[];
  env: RustRouteEnv;
  routes: WalkRoute[];
  mounts: RustMount[];
  clapCommands: string[];
  /** 外层函数在 out 里的下标 → 闭包起始位置 → 闭包符号在 out 里的下标 */
  closures: Map<number, Map<number, number>>;
}

/** 当前所在的模块（文件或内联 mod）或函数 */
interface Scope {
  qn: string;
  parent: number;
  /** 在 `#[cfg(test)]` 模块里 */
  test: boolean;
  /** 所在的内联 mod（相对文件模块） */
  mod: string[];
  /** `Self` 指的类型路径和外层的类型参数约束；函数体里的函数没有 */
  selfType?: string[];
  bounds: Record<string, string[]>;
}

function typeScope(w: RustWalk, scope: Scope, item: Node): RustTypeScope {
  const base: RustTypeScope = { modPath: [...w.modulePath, ...scope.mod], mod: scope.mod, selfType: scope.selfType, bounds: scope.bounds };
  return { ...base, bounds: rustBounds(item, base) };
}

type SymbolFields = Pick<RawSymbol, 'kind' | 'name' | 'qualifiedName' | 'displaySignature' | 'parent' | 'normTokens'>;

/** item 为项本身，nameNode 为名字标识符；bodyHash 含前面的属性 */
function push(w: RustWalk, item: Node, nameNode: Node, test: boolean, fields: SymbolFields): number {
  const attrs = itemAttributes(item);
  const start = attrs[0]?.startIndex ?? item.startIndex;
  const text = w.source.slice(start, item.endIndex);
  w.out.push({
    ...fields,
    signature: '',
    path: w.path,
    startLine: item.startPosition.row + 1,
    endLine: item.endPosition.row + 1,
    bodyHash: sha1(text),
    docstring: rustDocComment(item),
    isTest: w.flags.isTest || test || attrs.some(isTestAttribute),
    isGenerated: w.flags.isGenerated,
    nameLine: nameNode.startPosition.row,
    nameCol: nameNode.startPosition.column,
    modelKind: null,
  });
  return w.out.length - 1;
}

function bodyTokens(fn: Node): string[] {
  const body = fn.childForFieldName('body');
  return body ? normalizeTokens([body], RUST_TOKENS) : [];
}

/** 函数的类型上下文，带上它和外层函数体里的 use；调用点和路由处理函数共用 */
function fnTypeScope(w: RustWalk, scope: Scope, fn: Node): RustTypeScope {
  const base = typeScope(w, scope, fn);
  const localUses = rustFnUseBindings(w.uses, fnStarts(fn), w.modulePath);
  return Object.keys(localUses).length > 0 ? { ...base, localUses } : base;
}

/** 函数或方法；函数体里定义的函数一并提取，父符号为外层函数 */
function addFunction(w: RustWalk, fn: Node, scope: Scope, kind: 'function' | 'method', qnPrefix = scope.qn): number | undefined {
  const nameNode = fn.childForFieldName('name');
  if (!nameNode) return undefined;
  const name = stripRaw(nameNode.text);
  const qualifiedName = `${qnPrefix}::${name}`;
  const idx = push(w, fn, nameNode, scope.test, {
    kind, name, qualifiedName, displaySignature: rustHead(fn, fn.childForFieldName('body')), parent: scope.parent, normTokens: bodyTokens(fn),
  });
  w.fns.push({ idx, node: fn, scope: fnTypeScope(w, scope, fn) });
  const body = fn.childForFieldName('body');
  if (body) addNestedFunctions(w, body, { qn: qualifiedName, parent: idx, test: w.out[idx]!.isTest, mod: scope.mod, bounds: {} });
  return idx;
}

/** 函数体里自己的 impl、trait、mod 块里的项不提取 */
const NESTED_SKIP = new Set(['impl_item', 'trait_item', 'mod_item']);

/** 函数体里（不进入更内层的函数和 impl、trait、mod 块）定义的函数 */
function addNestedFunctions(w: RustWalk, node: Node, scope: Scope): void {
  for (const c of node.namedChildren) {
    if (c.type === 'function_item') addFunction(w, c, scope, 'function');
    else if (!NESTED_SKIP.has(c.type)) addNestedFunctions(w, c, scope);
  }
}

/** derive 名（路径取最后一段）和其他属性路径 */
function derivesOf(item: Node): RustDerives {
  const derives: string[] = [];
  const attrs: string[] = [];
  for (const a of itemAttributes(item)) {
    const p = attributePath(a);
    if (p !== 'derive') {
      if (p) attrs.push(p);
      continue;
    }
    for (const d of attributeArgs(a).replace(/^\(|\)$/g, '').split(',')) {
      const last = d.trim().split('::').pop()?.trim();
      if (last) derives.push(last);
    }
  }
  return { derives, attrs };
}

/** struct / enum / union */
function addType(w: RustWalk, item: Node, scope: Scope): void {
  const nameNode = item.childForFieldName('name');
  if (!nameNode) return;
  const name = stripRaw(nameNode.text);
  const qualifiedName = `${scope.qn}::${name}`;
  const idx = push(w, item, nameNode, scope.test, {
    kind: 'class', name, qualifiedName, displaySignature: rustHead(item, item.childForFieldName('body')), parent: scope.parent, normTokens: [],
  });
  w.types.set(qualifiedName, idx);
  if (item.type === 'struct_item') {
    w.structs.push({ idx, node: item, scope: typeScope(w, { ...scope, selfType: ['crate', ...w.modulePath, ...scope.mod, name] }, item) });
  }
  const d = derivesOf(item);
  if (d.derives.length > 0 || d.attrs.length > 0) w.derives.set(idx, d);
  if (item.type === 'enum_item' && w.env.frameworks.has('clap') && d.derives.includes('Subcommand')) w.clapCommands.push(...clapVariantNames(item));
}

const FN_ITEMS = new Set(['function_item', 'function_signature_item']);

/** trait 和它声明或带默认实现的方法 */
function addTrait(w: RustWalk, item: Node, scope: Scope): void {
  const nameNode = item.childForFieldName('name');
  const body = item.childForFieldName('body');
  if (!nameNode) return;
  const name = stripRaw(nameNode.text);
  const qualifiedName = `${scope.qn}::${name}`;
  const idx = push(w, item, nameNode, scope.test, {
    kind: 'interface', name, qualifiedName, displaySignature: rustHead(item, body), parent: scope.parent, normTokens: [],
  });
  w.types.set(qualifiedName, idx);
  const selfType = ['crate', ...w.modulePath, ...scope.mod, name];
  const inner: Scope = { ...scope, qn: qualifiedName, parent: idx, test: w.out[idx]!.isTest, selfType, bounds: typeScope(w, scope, item).bounds };
  for (const m of body?.namedChildren ?? []) if (FN_ITEMS.has(m.type)) addFunction(w, m, inner, 'method');
}

/** impl 块里的方法：固有 impl 为 `<模块>::Type::m`，trait impl 为 `<模块>::<Type as Trait>::m` */
function addImpl(w: RustWalk, item: Node, scope: Scope): void {
  const typeName = stripRaw(implTypeName(item.childForFieldName('type')));
  if (!typeName) return;
  const trait = item.childForFieldName('trait');
  const owner = trait ? `<${typeName} as ${normalizeTraitText(trait.text)}>` : typeName;
  const test = scope.test || itemAttributes(item).some(isCfgTest);
  const selfType = rustImplTypePath(item.childForFieldName('type'), [...w.modulePath, ...scope.mod]);
  const inner: Scope = { ...scope, test, selfType, bounds: typeScope(w, scope, item).bounds };
  for (const m of item.childForFieldName('body')?.namedChildren ?? []) {
    if (m.type !== 'function_item') continue;
    const idx = addFunction(w, m, inner, 'method', `${scope.qn}::${owner}`);
    if (idx === undefined) continue;
    w.implOwners.set(idx, `${scope.qn}::${typeName}`);
    if (selfType) w.implTypes.set(idx, scope.mod.length > 0 ? { segments: selfType, mod: scope.mod } : { segments: selfType });
  }
}

/** 一个模块（文件或内联 mod）里的项 */
function walkItems(w: RustWalk, container: Node, scope: Scope): void {
  for (const n of container.namedChildren) {
    switch (n.type) {
      case 'function_item':
        addFunction(w, n, scope, 'function');
        break;
      case 'struct_item':
      case 'enum_item':
      case 'union_item':
        addType(w, n, scope);
        break;
      case 'trait_item':
        addTrait(w, n, scope);
        break;
      case 'impl_item':
        addImpl(w, n, scope);
        break;
      case 'mod_item':
        walkInlineMod(w, n, scope);
        break;
      default:
        break;
    }
  }
}

function walkInlineMod(w: RustWalk, mod: Node, scope: Scope): void {
  const body = mod.childForFieldName('body');
  const name = mod.childForFieldName('name');
  if (!body || !name) return;
  const test = scope.test || itemAttributes(mod).some(isCfgTest);
  const modName = stripRaw(name.text);
  w.inlineMods.push([...scope.mod, modName]);
  walkItems(w, body, { qn: `${scope.qn}::${modName}`, parent: scope.parent, test, mod: [...scope.mod, modName], bounds: {} });
}

/** impl 方法的父符号：本文件有同一模块里的目标类型时为该类型，否则先挂在 module 上（跨文件处理时补） */
function linkImplOwners(w: RustWalk): void {
  for (const [idx, typeQn] of w.implOwners) w.out[idx]!.parent = w.types.get(typeQn) ?? 0;
}

/** 作为路由处理函数的闭包的符号 `<外层函数>::closure<N>`，N 为外层函数里第几个闭包；同一个闭包只建一次 */
function closureSymbol(w: RustWalk, fn: RustWalk['fns'][number], closure: Node): number {
  const known = w.closures.get(fn.idx) ?? new Map<number, number>();
  w.closures.set(fn.idx, known);
  const existing = known.get(closure.startIndex);
  if (existing !== undefined) return existing;
  const outer = w.out[fn.idx]!;
  const name = `closure${fnClosures(fn.node).findIndex((c) => c.startIndex === closure.startIndex) + 1}`;
  const body = closure.childForFieldName('body');
  const idx = push(w, closure, closure, outer.isTest, {
    kind: 'function', name, qualifiedName: `${outer.qualifiedName}::${name}`, displaySignature: rustHead(closure, body),
    parent: fn.idx, normTokens: body ? normalizeTokens([body], RUST_TOKENS) : [],
  });
  known.set(closure.startIndex, idx);
  return idx;
}

/** 每个函数上的路由属性和函数体里的链式路由、mount、clap 子命令；作为处理函数的闭包建符号 */
function collectEntryFacts(w: RustWalk): void {
  for (const fn of [...w.fns]) {
    const attr = rustAttrRoute(fn.node, w.env);
    if (attr) w.routes.push({ ...attr, handler: { idx: fn.idx } });
    const c = collectFnRoutes(fn.node, fn.scope, w.env);
    w.mounts.push(...c.mounts);
    w.clapCommands.push(...c.clapCommands);
    for (const r of c.routes) {
      const handler = 'closure' in r.handler ? { idx: closureSymbol(w, fn, r.handler.closure) } : r.handler;
      w.routes.push({ ...r, handler });
    }
  }
}

/** 入口相关的 rust 字段，下标换成符号 id；没有的字段不写 */
function entryFacts(w: RustWalk, symbols: ExtractedSymbol[]): Pick<RustFileFacts, 'routes' | 'mounts' | 'clapCommands'> {
  const routes: RustRoute[] = w.routes.map((r) => ({ ...r, handler: 'idx' in r.handler ? { symbolId: symbols[r.handler.idx]!.id } : r.handler }));
  return {
    ...(routes.length > 0 ? { routes } : {}),
    ...(w.mounts.length > 0 ? { mounts: w.mounts } : {}),
    ...(w.clapCommands.length > 0 ? { clapCommands: [...new Set(w.clapCommands)] } : {}),
  };
}

/** module 符号的名字：文件名去掉 `.rs`，`mod.rs` 取目录名 */
function moduleName(filePath: string): string {
  const base = path.posix.basename(filePath, '.rs');
  return base === 'mod' ? path.posix.basename(path.posix.dirname(filePath)) : base;
}

export function rustModuleQualifiedName(unit: RustFileUnit): string {
  return [unit.crate, ...unit.modulePath].join('::');
}

function moduleSymbol(filePath: string, unit: RustFileUnit, root: Node, source: string, flags: FileFlags): RawSymbol {
  return {
    kind: 'module', name: moduleName(filePath), qualifiedName: rustModuleQualifiedName(unit), signature: '', displaySignature: '', parent: null,
    path: filePath, startLine: 1, endLine: root.endPosition.row + 1, bodyHash: sha1(source), normTokens: [],
    docstring: rustModuleDoc(root), isTest: flags.isTest, isGenerated: flags.isGenerated, nameLine: 0, nameCol: 0, modelKind: null,
  };
}

function derivesById(w: RustWalk, symbols: ExtractedSymbol[]): Record<string, RustDerives> {
  const out: Record<string, RustDerives> = {};
  for (const [idx, d] of w.derives) out[symbols[idx]!.id] = d;
  return out;
}

/** 函数和它外层函数的起始位置：这些函数体里的 use 对该函数生效 */
function fnStarts(fn: Node): Set<number> {
  const out = new Set<number>();
  for (let p: Node | null = fn; p; p = p.parent) if (p.type === 'function_item') out.add(p.startIndex);
  return out;
}

/** 调用点、返回类型、struct 字段类型、impl 目标类型，按符号 id 记 */
function typeFacts(w: RustWalk, symbols: ExtractedSymbol[]): Pick<RustFileFacts, 'calls' | 'fnResults' | 'structFields' | 'implTypes'> {
  const out: Pick<RustFileFacts, 'calls' | 'fnResults' | 'structFields' | 'implTypes'> = { calls: [], fnResults: {}, structFields: {}, implTypes: {} };
  for (const { idx, node, scope } of w.fns) {
    const id = symbols[idx]!.id;
    const closures = w.closures.get(idx);
    const closureIds = closures && new Map([...closures].map(([start, i]) => [start, symbols[i]!.id]));
    out.calls.push(...collectRustCalls(node, id, scope, closureIds));
    const result = rustFnResult(node, scope);
    if (result) out.fnResults[id] = result;
  }
  for (const { idx, node, scope } of w.structs) {
    const fields = rustStructFields(node, scope);
    if (Object.keys(fields).length > 0) out.structFields[symbols[idx]!.id] = fields;
  }
  for (const [idx, ref] of w.implTypes) out.implTypes[symbols[idx]!.id] = ref;
  return out;
}

/** use 展开结果和路径第一段：入口识别（按 use 区分框架）和 rust 字段共用 */
interface UseInfo {
  uses: RustUseItem[];
  pathRoots: string[];
}

function fileFacts(root: Node, unit: RustFileUnit, w: RustWalk, symbols: ExtractedSymbol[], u: UseInfo): RustFileFacts {
  return {
    crate: unit.crate, target: unit.target, ...(unit.kind ? { targetKind: unit.kind } : {}), modulePath: unit.modulePath,
    ...(unit.packageDir !== undefined ? { packageDir: unit.packageDir } : {}),
    ...rustUseBindings(u.uses, unit.modulePath), ...typeFacts(w, symbols), inlineMods: w.inlineMods,
    useLeaves: u.uses.map((x) => x.leaf), ...collectRustMacrosAndMods(root),
    derives: derivesById(w, symbols), pathRoots: u.pathRoots, envReads: collectRustEnvReads(root, u.uses), ...entryFacts(w, symbols),
  };
}

function extractTree(root: Node, filePath: string, source: string, flags: FileFlags, crates: ReadonlyMap<string, RustPackage>): ExtractedFile {
  const unit = rustFileUnit(filePath, crates);
  const module = moduleSymbol(filePath, unit, root, source, flags);
  const uses = expandRustUses(root);
  const u: UseInfo = { uses, pathRoots: collectRustPathRoots(root, uses) };
  const deps = unit.packageDir !== undefined ? (crates.get(unit.packageDir)?.deps ?? []) : [];
  const w: RustWalk = {
    path: filePath, source, flags, out: [module], types: new Map(), implOwners: new Map(), derives: new Map(),
    modulePath: unit.modulePath, fns: [], structs: [], implTypes: new Map(), inlineMods: [], uses,
    env: rustRouteEnv(deps, u.pathRoots), routes: [], mounts: [], clapCommands: [], closures: new Map(),
  };
  walkItems(w, root, { qn: module.qualifiedName, parent: 0, test: false, mod: [], bounds: {} });
  linkImplOwners(w);
  collectEntryFacts(w);
  const symbols = finalizeSymbols(w.out);
  return {
    path: filePath, language: 'rust', symbols, entries: [], importRows: rustUseRows(root), imports: new Map(),
    rust: fileFacts(root, unit, w, symbols, u),
  };
}

/**
 * 提取一个 Rust 文件：module 符号、函数（含函数体里的函数）、struct/enum/union、trait 和 trait 方法、impl 里的方法、
 * 作为路由处理函数的闭包，以及 rust 字段（crate 目标和模块路径、use 叶子位置、`mod` 声明、derive、路径第一段、环境变量、
 * 宏范围、路由和 clap 子命令）。
 * 宏调用里的项不提取；impl 方法跨文件的父符号由跨文件处理补上
 */
export function extractRustFile(
  parser: Parser, filePath: string, source: string, flags: FileFlags, crates: ReadonlyMap<string, RustPackage>,
): ExtractedFile {
  const tree = parser.parse(source);
  if (!tree) throw new Error(`tree-sitter failed to parse ${filePath}`);
  try {
    return extractTree(tree.rootNode, filePath, source, flags, crates);
  } finally {
    tree.delete();
  }
}

/** 用已入库的符号还原 Rust 文件：重新解析源码得到 rust 字段和名字位置，符号以库里为准（含跨文件补上的父符号） */
export function restoreRustFile(
  parser: Parser, filePath: string, source: string, rows: Omit<SymbolRow, 'snapshotId'>[], crates: ReadonlyMap<string, RustPackage>,
): ExtractedFile {
  const module = rows.find((r) => r.kind === 'module');
  const flags = { isTest: module?.isTest ?? false, isGenerated: module?.isGenerated ?? false };
  const fresh = extractRustFile(parser, filePath, source, flags, crates);
  return { ...fresh, symbols: restoredSymbols(fresh.symbols, rows) };
}
