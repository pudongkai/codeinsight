import { createHash } from 'node:crypto';
import type { Node, Parser } from 'web-tree-sitter';
import { dedupeQualifiedNames, makeSymbolKey, symbolIdFromKey } from '../model/symbol-key.js';
import type { SymbolRow } from '../model/types.js';
import { decoratorEntry, djangoRoutes, fileFrameworks } from './entries.js';
import { baseVars, classHints } from './models.js';
import { normalizeTokens } from './normalize.js';
import type { ExtractedEntry, ExtractedFile, ExtractedSymbol, ImportBinding } from './types.js';

const DOCSTRING_MAX = 500;

export interface FileFlags {
  isTest: boolean;
  isGenerated: boolean;
}

/** 提取前、去重前的符号；parent 为父符号在列表里的下标 */
interface RawSymbol extends Omit<ExtractedSymbol, 'id' | 'symbolKey' | 'parentId'> {
  parent: number | null;
  decorators: Node[];
  /** 类的定义节点，模型识别要读基类列表 */
  classDef?: Node;
}

interface WalkContext {
  path: string;
  source: string;
  flags: FileFlags;
  out: RawSymbol[];
}

export function sha1(text: string | Uint8Array): string {
  return createHash('sha1').update(text).digest('hex');
}

/** 模块的点分路径：`a/b/c.py` → `a.b.c`，`a/b/__init__.py` → `a.b` */
export function moduleDottedName(filePath: string): string {
  const noExt = filePath.replace(/\.pyi?$/, '');
  const parts = noExt.split('/');
  if (parts[parts.length - 1] === '__init__' && parts.length > 1) parts.pop();
  return parts.join('.');
}

/** 叶子 token；字符串字面量整体作为一个 token，注释丢弃 */
function leafTokens(node: Node, out: Node[] = []): Node[] {
  if (node.type === 'comment') return out;
  if (node.type === 'string' || node.childCount === 0) {
    out.push(node);
    return out;
  }
  for (const c of node.children) leafTokens(c, out);
  return out;
}

/**
 * 节点原文去掉注释、空白折叠成一个空格；括号内侧的空白去掉，最外层右括号前多余的逗号去掉
 * （嵌套括号里的逗号可能有语义，如 `(1,)`，保留）。按 token 拼接，字符串字面量里的内容保持原样。
 */
function compactText(node: Node): string {
  const parts: string[] = [];
  let prevEnd = -1;
  const tokens = leafTokens(node);
  for (const [i, tok] of tokens.entries()) {
    const text = tok.text;
    const closing = text === ')' || text === ']';
    if (closing && i === tokens.length - 1 && parts[parts.length - 1] === ',') parts.pop();
    const prev = parts[parts.length - 1];
    const gap = prevEnd >= 0 && tok.startIndex > prevEnd;
    if (gap && prev !== undefined && prev !== '(' && prev !== '[' && !closing) parts.push(' ');
    parts.push(text);
    prevEnd = tok.endIndex;
  }
  return parts.join('').trim();
}

function displaySignature(def: Node): string {
  if (def.type === 'class_definition') {
    const sup = def.childForFieldName('superclasses');
    return sup ? compactText(sup) : '';
  }
  const params = def.childForFieldName('parameters');
  const ret = def.childForFieldName('return_type');
  return (params ? compactText(params) : '()') + (ret ? ` -> ${compactText(ret)}` : '');
}

/** 第一条语句是字符串时为 docstring；前面的注释（编码声明、许可证头）跳过 */
function docstringNode(body: Node | null): Node | undefined {
  const first = body?.namedChildren.find((n) => n.type !== 'comment');
  if (first?.type !== 'expression_statement') return undefined;
  const expr = first.firstNamedChild;
  return expr?.type === 'string' || expr?.type === 'concatenated_string' ? first : undefined;
}

function docstringText(stmt: Node | undefined): string | null {
  if (!stmt) return null;
  const raw = stmt.text.replace(/^[rRbBuUfF]*("""|'''|"|')/, '').replace(/("""|'''|"|')$/, '').trim();
  return raw.slice(0, DOCSTRING_MAX);
}

/**
 * 去掉节点第一行所在行的缩进（空格或 tab）在后续各行上的同样前缀，
 * 函数整体缩进变化（如搬进类里）不影响 hash
 */
function dedentedText(node: Node, source: string): string {
  const lineStart = source.lastIndexOf('\n', node.startIndex - 1) + 1;
  const indent = source.slice(lineStart, node.startIndex);
  if (indent === '' || /\S/.test(indent)) return node.text;
  const lines = node.text.split('\n');
  return [lines[0], ...lines.slice(1).map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l))].join('\n');
}

const DEFINITION_TYPES = new Set(['function_definition', 'class_definition', 'decorated_definition']);

/** 单独的 `pass` 或 `...` 语句：只是占位，类里有没有它不算类自身的修改 */
function isPlaceholder(n: Node): boolean {
  return n.type === 'pass_statement' || (n.type === 'expression_statement' && n.namedChildCount === 1 && n.firstNamedChild?.type === 'ellipsis');
}

/**
 * 类体里类自身的部分：去掉直接定义在类体里的方法和嵌套类（它们是独立的符号，各自判断是否修改），
 * 以及占位用的 `pass` / `...`（方法搬走后补上或搬来后删掉它们不算类的修改），
 * 保留类属性、docstring 等其余语句，各自去缩进
 */
function classOwnText(body: Node, source: string): string {
  return body.namedChildren
    .filter((n) => !DEFINITION_TYPES.has(n.type) && !isPlaceholder(n))
    .map((n) => dedentedText(n, source))
    .join('\n');
}

/**
 * body_hash = 装饰器 + 函数体（各自去缩进）的 hash，不含 def 行的签名（签名变化看 display_signature）。
 * 包含装饰器：路由、权限等入口信息写在装饰器里，只改装饰器也要算修改。
 * 类只算类装饰器和类自身的部分，不含方法，改一个方法不会让类也算作修改；基类列表在 display_signature 里。
 */
function bodyHash(def: Node, outer: Node, body: Node | null, source: string): string {
  const decorators = outer === def ? [] : outer.namedChildren.filter((n) => n.type === 'decorator');
  const parts = decorators.map((n) => dedentedText(n, source));
  if (def.type === 'class_definition') parts.push(body ? classOwnText(body, source) : '');
  else parts.push(dedentedText(body ?? def, source));
  return sha1(parts.join('\n'));
}

function bodyTokens(def: Node): string[] {
  const body = def.childForFieldName('body');
  if (!body) return [];
  const doc = docstringNode(body);
  // web-tree-sitter 每次访问都返回新的 Node 对象，按位置比较
  return normalizeTokens(body.namedChildren.filter((n) => n.startIndex !== doc?.startIndex));
}

function qualify(scope: RawSymbol | undefined, name: string): string {
  if (!scope || scope.kind === 'module') return name;
  return scope.kind === 'class' ? `${scope.qualifiedName}.${name}` : `${scope.qualifiedName}.<locals>.${name}`;
}

function defKind(def: Node, scope: RawSymbol | undefined): string {
  if (def.type === 'class_definition') return 'class';
  return scope?.kind === 'class' ? 'method' : 'function';
}

/** outer 是带装饰器时的 decorated_definition，否则就是 def 本身 */
function addDefinition(ctx: WalkContext, def: Node, outer: Node, scopeIdx: number): void {
  const nameNode = def.childForFieldName('name');
  if (!nameNode) return;
  const scope = ctx.out[scopeIdx];
  const kind = defKind(def, scope);
  const body = def.childForFieldName('body');
  ctx.out.push({
    kind,
    name: nameNode.text,
    qualifiedName: qualify(scope, nameNode.text),
    signature: '',
    displaySignature: displaySignature(def),
    parent: scope?.kind === 'module' ? null : scopeIdx,
    path: ctx.path,
    startLine: outer.startPosition.row + 1,
    endLine: outer.endPosition.row + 1,
    bodyHash: bodyHash(def, outer, body, ctx.source),
    normTokens: kind === 'class' ? [] : bodyTokens(def),
    docstring: docstringText(docstringNode(body)),
    isTest: ctx.flags.isTest,
    isGenerated: ctx.flags.isGenerated,
    nameLine: nameNode.startPosition.row,
    nameCol: nameNode.startPosition.column,
    modelKind: null,
    decorators: outer === def ? [] : outer.namedChildren.filter((n) => n.type === 'decorator'),
    ...(kind === 'class' ? { classDef: def } : {}),
  });
  if (body) walk(ctx, body, ctx.out.length - 1);
}

function walk(ctx: WalkContext, node: Node, scopeIdx: number): void {
  for (const child of node.namedChildren) {
    if (child.type === 'decorated_definition') {
      const def = child.childForFieldName('definition');
      if (def) addDefinition(ctx, def, child, scopeIdx);
    } else if (child.type === 'function_definition' || child.type === 'class_definition') {
      addDefinition(ctx, child, child, scopeIdx);
    } else {
      walk(ctx, child, scopeIdx);
    }
  }
}

function moduleSymbol(path: string, root: Node, source: string, flags: FileFlags): RawSymbol {
  const qn = moduleDottedName(path);
  return {
    kind: 'module',
    name: qn.split('.').pop() ?? qn,
    qualifiedName: qn,
    signature: '',
    displaySignature: '',
    parent: null,
    path,
    startLine: 1,
    endLine: root.endPosition.row + 1,
    bodyHash: sha1(source),
    normTokens: [],
    docstring: docstringText(docstringNode(root)),
    isTest: flags.isTest,
    isGenerated: flags.isGenerated,
    nameLine: 0,
    nameCol: 0,
    modelKind: null,
    decorators: [],
  };
}

/** 去重 qualified_name 后计算 symbol_key、id 和 parent_id */
function finalizeSymbols(raw: RawSymbol[]): { symbols: ExtractedSymbol[]; decorators: Node[][]; classDefs: (Node | undefined)[] } {
  const deduped = dedupeQualifiedNames(raw);
  const ids = deduped.map((s) => symbolIdFromKey(makeSymbolKey(s)));
  const symbols = deduped.map(({ parent, decorators: _decorators, classDef: _def, ...rest }, i): ExtractedSymbol => ({
    ...rest,
    symbolKey: makeSymbolKey(rest),
    id: ids[i]!,
    parentId: parent === null ? null : ids[parent]!,
  }));
  return { symbols, decorators: raw.map((s) => s.decorators), classDefs: raw.map((s) => s.classDef) };
}

function importRows(root: Node): [number, number][] {
  return root
    .descendantsOfType(['import_statement', 'import_from_statement', 'future_import_statement'])
    .map((n) => [n.startPosition.row, n.endPosition.row]);
}

function resolveRelative(filePath: string, moduleNode: Node): string {
  if (moduleNode.type !== 'relative_import') return moduleNode.text;
  const prefix = moduleNode.namedChildren.find((n) => n.type === 'import_prefix')?.text ?? '.';
  const rest = moduleNode.namedChildren.find((n) => n.type === 'dotted_name')?.text;
  const pkg = moduleDottedName(filePath).split('.');
  if (!/\/__init__\.pyi?$/.test(filePath)) pkg.pop();
  const base = pkg.slice(0, pkg.length - (prefix.length - 1));
  return [...base, ...(rest ? [rest] : [])].filter(Boolean).join('.');
}

function bindName(out: Map<string, ImportBinding>, nameNode: Node, toBinding: (name: string) => ImportBinding): void {
  if (nameNode.type === 'aliased_import') {
    const name = nameNode.childForFieldName('name')?.text;
    const alias = nameNode.childForFieldName('alias')?.text;
    if (name && alias) out.set(alias, toBinding(name));
  } else if (nameNode.type === 'dotted_name') {
    out.set(nameNode.text.split('.')[0]!, toBinding(nameNode.text));
  }
}

/** 一条 import 语句：`import a.b, c as d`（from 为 undefined）或 `from <from> import <names>` */
interface ImportStatement {
  from?: Node;
  names: Node[];
}

/** import 语句遍历，collectImports 和 collectImportModules 共用；`from __future__` 不在其中 */
function importStatements(root: Node): ImportStatement[] {
  const out: ImportStatement[] = [];
  for (const stmt of root.descendantsOfType(['import_statement', 'import_from_statement'])) {
    const names = stmt.childrenForFieldName('name');
    if (stmt.type === 'import_statement') {
      out.push({ names });
      continue;
    }
    const from = stmt.childForFieldName('module_name');
    if (from) out.push({ from, names });
  }
  return out;
}

/** 收集 import 别名，用于 Django 路由和模型类的基类跨文件查找 */
function collectImports(filePath: string, root: Node): Map<string, ImportBinding> {
  const out = new Map<string, ImportBinding>();
  for (const { from, names } of importStatements(root)) {
    if (!from) {
      for (const n of names) bindName(out, n, (name) => ({ module: n.type === 'aliased_import' ? name : name.split('.')[0]! }));
      continue;
    }
    const module = resolveRelative(filePath, from);
    for (const n of names) bindName(out, n, (name) => ({ module, name }));
  }
  return out;
}

/** 一条导入的模块：完整点分名，相对导入保留原文（如 `.models`）且不解析成项目内模块名 */
export interface ImportedModule {
  module: string;
  relative: boolean;
  /** `from a.b import c` 时的候选子模块 `a.b.c`（c 可能是子模块，如 `from google.cloud import storage`） */
  candidates: string[];
}

function importedName(n: Node): string | undefined {
  return n.type === 'aliased_import' ? n.childForFieldName('name')?.text : n.type === 'dotted_name' ? n.text : undefined;
}

/**
 * 收集 import 的模块名，用于判断外部依赖：`import a.b.c` 记 `a.b.c`；
 * `from a.b import c` 记 `a.b`，候选 `a.b.c`；相对导入记 `relative: true`。
 */
export function collectImportModules(root: Node): ImportedModule[] {
  const out: ImportedModule[] = [];
  for (const { from, names } of importStatements(root)) {
    const imported = names.map(importedName).filter((n): n is string => n !== undefined);
    if (!from) {
      for (const module of imported) out.push({ module, relative: false, candidates: [] });
      continue;
    }
    const relative = from.type === 'relative_import';
    out.push({ module: from.text, relative, candidates: relative ? [] : imported.map((n) => `${from.text}.${n}`) });
  }
  return out;
}

function decoratorEntries(symbols: ExtractedSymbol[], decorators: Node[][], frameworks: Set<string>): ExtractedEntry[] {
  const entries: ExtractedEntry[] = [];
  symbols.forEach((s, i) => {
    if (s.kind !== 'function' && s.kind !== 'method') return;
    for (const d of decorators[i] ?? []) {
      const e = decoratorEntry(d, frameworks);
      if (e) entries.push({ symbolId: s.id, ...e });
    }
  });
  return entries;
}

/**
 * 提取一个 Python 文件：module 符号、类、函数、方法、嵌套函数，装饰器形式的入口，以及模型识别的线索。
 * 符号的 modelKind 要等全部文件提取完后由 resolveModels 填写
 */
export function extractPythonFile(parser: Parser, filePath: string, source: string, flags: FileFlags): ExtractedFile {
  const tree = parser.parse(source);
  if (!tree) throw new Error(`tree-sitter failed to parse ${filePath}`);
  try {
    const root = tree.rootNode;
    const ctx: WalkContext = { path: filePath, source, flags, out: [moduleSymbol(filePath, root, source, flags)] };
    walk(ctx, root, 0);
    const { symbols, decorators, classDefs } = finalizeSymbols(ctx.out);
    const isUrls = /(^|\/)urls\.py$/.test(filePath);
    return {
      path: filePath,
      symbols,
      entries: decoratorEntries(symbols, decorators, fileFrameworks(root)),
      importRows: importRows(root),
      djangoRoutes: isUrls ? djangoRoutes(root) : [],
      imports: collectImports(filePath, root),
      classes: classHints(symbols, classDefs, decorators),
      baseVars: baseVars(root),
    };
  } finally {
    tree.delete();
  }
}

/** 定义名字的位置，按 `名字@含装饰器的起始行` 索引 */
function definitionNamePositions(root: Node): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  for (const def of root.descendantsOfType(['function_definition', 'class_definition'])) {
    const name = def.childForFieldName('name');
    if (!name) continue;
    const outer = def.parent?.type === 'decorated_definition' ? def.parent : def;
    out.set(`${name.text}@${outer.startPosition.row}`, [name.startPosition.row, name.startPosition.column]);
  }
  return out;
}

/**
 * 用已入库的符号还原解析层需要的 ExtractedFile：符号和 id 以库里为准，
 * 只从源码补出库里没有的名字位置和 import 行。用于只重跑解析、不重新提取的场景。
 */
export function restoreExtractedFile(
  parser: Parser, filePath: string, source: string, rows: Omit<SymbolRow, 'snapshotId'>[],
): ExtractedFile {
  const tree = parser.parse(source);
  if (!tree) throw new Error(`tree-sitter failed to parse ${filePath}`);
  try {
    const names = definitionNamePositions(tree.rootNode);
    const ordered = [...rows].sort((a, b) => (a.kind === 'module' ? -1 : b.kind === 'module' ? 1 : a.startLine - b.startLine));
    const symbols = ordered.map((r): ExtractedSymbol => {
      const [nameLine, nameCol] = r.kind === 'module' ? [0, 0] : (names.get(`${r.name}@${r.startLine - 1}`) ?? [r.startLine - 1, 0]);
      return { ...r, nameLine, nameCol };
    });
    return { path: filePath, symbols, entries: [], importRows: importRows(tree.rootNode), djangoRoutes: [], imports: new Map() };
  } finally {
    tree.delete();
  }
}
