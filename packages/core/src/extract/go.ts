import path from 'node:path';
import type { Node, Parser } from 'web-tree-sitter';
import type { SymbolRow } from '../model/types.js';
import { sha1 } from '../util/hash.js';
import { collectCalls } from './go-calls.js';
import { addFunc, addTypeDeclaration, linkReceivers, type DeclWalk } from './go-decls.js';
import { collectGoEnvReads, collectGoImports, goImportBindings, goImportRows } from './go-imports.js';
import { goPackagePath } from './go-module.js';
import { goDocComment } from './go-syntax.js';
import { declareParams, fileTypeLookup, type GoTypeContext } from './go-types.js';
import type { FileFlags } from './python.js';
import { finalizeSymbols, type RawSymbol } from './symbols.js';
import type { ExtractedFile, ExtractedSymbol, GoCallSite, GoFileFacts, GoStructTags } from './types.js';

export { collectGoEnvReads, collectGoImports } from './go-imports.js';
export type { GoImport } from './go-imports.js';

function moduleSymbol(filePath: string, packagePath: string, root: Node, source: string, flags: FileFlags): RawSymbol {
  const pkgClause = root.namedChildren.find((n) => n.type === 'package_clause');
  const name = path.posix.basename(filePath);
  return {
    kind: 'module', name, qualifiedName: `${packagePath}/${name}`, signature: '', displaySignature: '', parent: null,
    path: filePath, startLine: 1, endLine: root.endPosition.row + 1, bodyHash: sha1(source), normTokens: [],
    docstring: pkgClause ? goDocComment(pkgClause) : null, isTest: flags.isTest, isGenerated: flags.isGenerated,
    nameLine: 0, nameCol: 0, modelKind: null,
  };
}

/** 顶层声明建符号，同时记下 struct 字段、函数返回类型、标签 */
function walkDecls(root: Node, w: DeclWalk): void {
  for (const n of root.namedChildren) {
    if (n.type === 'function_declaration' || n.type === 'method_declaration') addFunc(w, n);
    else if (n.type === 'type_declaration') addTypeDeclaration(w, n);
  }
  linkReceivers(w);
}

/** 各函数体和包级变量初始化里的调用点 */
function fileCalls(root: Node, w: DeclWalk, symbols: ExtractedSymbol[]): GoCallSite[] {
  const out: GoCallSite[] = [];
  const lookup = fileTypeLookup(w.ctx.packagePath, w.structFields, w.funcResults);
  for (const [idx, decl] of w.funcs) {
    const c = { ctx: w.ctx, lookup, callerId: symbols[idx]!.id, vars: new Map(), out };
    declareParams(decl.childForFieldName('receiver'), w.ctx, c.vars);
    declareParams(decl.childForFieldName('parameters'), w.ctx, c.vars);
    const body = decl.childForFieldName('body');
    if (body) collectCalls(body, c);
  }
  for (const n of root.namedChildren) {
    if (n.type === 'var_declaration') collectCalls(n, { ctx: w.ctx, lookup, callerId: symbols[0]!.id, vars: new Map(), out });
  }
  return out.sort((a, b) => a.line - b.line || a.col - b.col);
}

/** struct 标签按 struct 符号 id 记录 */
function structTagsById(w: DeclWalk, symbols: ExtractedSymbol[]): Record<string, GoStructTags> {
  const out: Record<string, GoStructTags> = {};
  for (const [idx, tags] of w.structTags) out[symbols[idx]!.id] = tags;
  return out;
}

function newWalk(filePath: string, flags: FileFlags, ctx: GoTypeContext, module: RawSymbol): DeclWalk {
  return {
    path: filePath, flags, ctx, out: [module], types: new Map(), receivers: new Map(), funcs: new Map(),
    structTags: new Map(), structFields: {}, funcResults: {},
  };
}

/** 包名和包导入路径 */
function packageOf(root: Node, filePath: string, goModules: ReadonlyMap<string, string>): { packageName: string; packagePath: string } {
  const packageName = root.namedChildren.find((n) => n.type === 'package_clause')?.namedChildren[0]?.text ?? '';
  return { packageName, packagePath: goPackagePath(filePath, goModules, packageName) };
}

/** 解析树上的提取：符号和 go 字段 */
function extractTree(root: Node, filePath: string, source: string, flags: FileFlags, goModules: ReadonlyMap<string, string>): ExtractedFile {
  const { packageName, packagePath } = packageOf(root, filePath, goModules);
  const bindings = goImportBindings(collectGoImports(root));
  const ctx: GoTypeContext = { packagePath, imports: bindings.imports };
  const w = newWalk(filePath, flags, ctx, moduleSymbol(filePath, packagePath, root, source, flags));
  walkDecls(root, w);
  const symbols = finalizeSymbols(w.out);
  const go: GoFileFacts = {
    packagePath, packageName, imports: bindings.imports, dotImports: bindings.dotImports,
    calls: fileCalls(root, w, symbols), structTags: structTagsById(w, symbols),
    envReads: collectGoEnvReads(root, bindings), structFields: w.structFields, funcResults: w.funcResults,
  };
  return { path: filePath, language: 'go', symbols, entries: [], importRows: goImportRows(root), imports: new Map(), go };
}

/**
 * 提取一个 Go 文件：module 符号、函数、方法、struct、interface 和 interface 方法，以及 go 字段
 * （import、调用点和局部类型推断、struct 标签、环境变量读取）。方法的跨文件父符号和要跨文件确定的
 * 接收者类型由跨文件处理补上
 */
export function extractGoFile(
  parser: Parser, filePath: string, source: string, flags: FileFlags, goModules: ReadonlyMap<string, string>,
): ExtractedFile {
  const tree = parser.parse(source);
  if (!tree) throw new Error(`tree-sitter failed to parse ${filePath}`);
  try {
    return extractTree(tree.rootNode, filePath, source, flags, goModules);
  } finally {
    tree.delete();
  }
}

/**
 * 用已入库的符号还原 Go 文件：重新解析源码得到 go 字段和名字位置，符号以库里为准（含跨文件补上的父符号）。
 * 名字位置按 id 对应，对不上时按 `名字@起始行` 对应
 */
export function restoreGoFile(
  parser: Parser, filePath: string, source: string, rows: Omit<SymbolRow, 'snapshotId'>[], goModules: ReadonlyMap<string, string>,
): ExtractedFile {
  const module = rows.find((r) => r.kind === 'module');
  const flags = { isTest: module?.isTest ?? false, isGenerated: module?.isGenerated ?? false };
  const fresh = extractGoFile(parser, filePath, source, flags, goModules);
  const byId = new Map(fresh.symbols.map((s) => [s.id, s]));
  const byName = new Map(fresh.symbols.map((s) => [`${s.name}@${s.startLine}`, s]));
  const ordered = [...rows].sort((a, b) => (a.kind === 'module' ? -1 : b.kind === 'module' ? 1 : a.startLine - b.startLine));
  const symbols = ordered.map((r): ExtractedSymbol => {
    const f = byId.get(r.id) ?? byName.get(`${r.name}@${r.startLine}`);
    return { ...r, nameLine: f?.nameLine ?? (r.kind === 'module' ? 0 : r.startLine - 1), nameCol: f?.nameCol ?? 0 };
  });
  return { ...fresh, symbols };
}
