import type { Node } from 'web-tree-sitter';
import type { DjangoRoute, ExtractedEntry, ExtractedFile, ExtractedSymbol } from './types.js';

/**
 * Python 入口识别：只看装饰器和调用的写法，不依赖在项目根目录检测框架。
 * 同一种写法可能属于多个框架（如 `@app.get`），按文件里 import 了哪个框架区分。
 */

type EntryInfo = Omit<ExtractedEntry, 'symbolId'>;

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const KNOWN_FRAMEWORKS = ['fastapi', 'flask', 'django', 'celery', 'click', 'typer'];

/** 文件 import 了哪些已知框架 */
export function fileFrameworks(root: Node): Set<string> {
  const found = new Set<string>();
  for (const stmt of root.descendantsOfType(['import_statement', 'import_from_statement'])) {
    for (const fw of KNOWN_FRAMEWORKS) if (new RegExp(`\\b${fw}\\b`).test(stmt.text)) found.add(fw);
  }
  return found;
}

/** `a.b.c` 这样的属性链转成名字列表；不是纯名字链时返回 undefined */
export function dottedParts(node: Node | null): string[] | undefined {
  if (!node) return undefined;
  if (node.type === 'identifier') return [node.text];
  if (node.type !== 'attribute') return undefined;
  const head = dottedParts(node.childForFieldName('object'));
  const attr = node.childForFieldName('attribute')?.text;
  return head && attr ? [...head, attr] : undefined;
}

function stringValue(node: Node | undefined | null): string | undefined {
  if (node?.type !== 'string') return undefined;
  return node.namedChildren.filter((n) => n.type === 'string_content').map((n) => n.text).join('');
}

function positionalArgs(args: Node | null): Node[] {
  return (args?.namedChildren ?? []).filter((n) => n.type !== 'keyword_argument' && n.type !== 'comment');
}

function keywordArg(args: Node | null, name: string): Node | undefined {
  const kw = (args?.namedChildren ?? []).find(
    (n) => n.type === 'keyword_argument' && n.childForFieldName('name')?.text === name,
  );
  return kw?.childForFieldName('value') ?? undefined;
}

function stringList(node: Node | undefined): string[] | undefined {
  if (!node || (node.type !== 'list' && node.type !== 'tuple')) return undefined;
  return node.namedChildren.map((n) => stringValue(n)).filter((s): s is string => s !== undefined);
}

function httpEntry(attr: string, args: Node | null, frameworks: Set<string>): EntryInfo {
  const prefersFlask = attr === 'route' ? !(frameworks.has('fastapi') && !frameworks.has('flask')) : frameworks.has('flask') && !frameworks.has('fastapi');
  const methods = HTTP_METHODS.has(attr) ? [attr.toUpperCase()] : (stringList(keywordArg(args, 'methods')) ?? ['GET']);
  const detail: Record<string, unknown> = { method: methods.join(','), path: stringValue(positionalArgs(args)[0]) };
  return { kind: 'http', framework: prefersFlask ? 'flask' : 'fastapi', detail };
}

function fastapiHookEntry(attr: string, args: Node | null): EntryInfo | undefined {
  const first = positionalArgs(args)[0];
  if (attr === 'exception_handler') return { kind: 'exception_handler', framework: 'fastapi', detail: { exception: first?.text } };
  if (attr === 'middleware') return { kind: 'http', framework: 'fastapi', detail: { middleware: stringValue(first) ?? first?.text } };
  if (attr === 'on_event') return { kind: 'event', framework: 'fastapi', detail: { event: stringValue(first) ?? first?.text } };
  return undefined;
}

function taskOrCliEntry(parts: string[], args: Node | null, frameworks: Set<string>): EntryInfo | undefined {
  const attr = parts[parts.length - 1]!;
  if ((parts.length >= 2 && attr === 'task') || (parts.length === 1 && attr === 'shared_task')) {
    return { kind: 'task', framework: 'celery', detail: { name: stringValue(keywordArg(args, 'name')) } };
  }
  if (attr === 'command' || attr === 'group') {
    if (parts.length < 2) return undefined;
    const typer = parts[0] !== 'click' && frameworks.has('typer') && !frameworks.has('click');
    return { kind: 'cli', framework: typer ? 'typer' : 'click', detail: { type: attr, name: stringValue(positionalArgs(args)[0]) } };
  }
  return undefined;
}

/** 识别一个装饰器是否把函数注册为入口 */
export function decoratorEntry(decorator: Node, frameworks: Set<string>): EntryInfo | undefined {
  const expr = decorator.firstNamedChild;
  if (!expr) return undefined;
  const isCall = expr.type === 'call';
  const parts = dottedParts(isCall ? expr.childForFieldName('function') : expr);
  if (!parts) return undefined;
  const args = isCall ? expr.childForFieldName('arguments') : null;
  const attr = parts[parts.length - 1]!;
  if (parts.length >= 2 && (HTTP_METHODS.has(attr) || attr === 'route' || attr === 'api_route')) {
    return isCall ? httpEntry(attr, args, frameworks) : undefined;
  }
  if (parts.length >= 2) {
    const hook = isCall ? fastapiHookEntry(attr, args) : undefined;
    if (hook) return hook;
  }
  return taskOrCliEntry(parts, args, frameworks);
}

/** urls.py 中 `path(...)` / `re_path(...)` 的第二个参数（函数或 `View.as_view()`） */
export function djangoRoutes(root: Node): DjangoRoute[] {
  const routes: DjangoRoute[] = [];
  for (const call of root.descendantsOfType('call')) {
    const fn = dottedParts(call.childForFieldName('function'));
    const fnName = fn?.[fn.length - 1];
    if (fnName !== 'path' && fnName !== 're_path') continue;
    const args = call.childForFieldName('arguments');
    const [route, view] = positionalArgs(args);
    const target = djangoViewTarget(view);
    if (!target) continue;
    routes.push({ target, detail: { path: stringValue(route), name: stringValue(keywordArg(args, 'name')) } });
  }
  return routes;
}

function djangoViewTarget(view: Node | undefined): string[] | undefined {
  if (!view) return undefined;
  if (view.type !== 'call') return dottedParts(view);
  const fn = dottedParts(view.childForFieldName('function'));
  return fn && fn.length >= 2 && fn[fn.length - 1] === 'as_view' ? fn.slice(0, -1) : undefined;
}

// ---- 跨文件查找（Django 路由、模型类的基类）----

export interface SymbolIndex {
  /** 模块点分路径 → 文件路径 */
  modules: Map<string, string>;
  /** 文件路径 → (qualified_name → 符号) */
  byFile: Map<string, Map<string, ExtractedSymbol>>;
  /** 名字 → 顶层函数和类 */
  byName: Map<string, ExtractedSymbol[]>;
}

export function buildIndex(files: ExtractedFile[]): SymbolIndex {
  const idx: SymbolIndex = { modules: new Map(), byFile: new Map(), byName: new Map() };
  for (const f of files) {
    const qmap = new Map<string, ExtractedSymbol>();
    for (const s of f.symbols) {
      if (s.kind === 'module') idx.modules.set(s.qualifiedName, f.path);
      else qmap.set(s.qualifiedName, s);
      if ((s.kind === 'function' || s.kind === 'class') && s.parentId === null) {
        idx.byName.set(s.name, [...(idx.byName.get(s.name) ?? []), s]);
      }
    }
    idx.byFile.set(f.path, qmap);
  }
  return idx;
}

/** 模块名可能不含源码根目录前缀（如 src/ 布局），精确匹配不到时按唯一的后缀匹配 */
export function findModuleFile(idx: SymbolIndex, module: string): string | undefined {
  const exact = idx.modules.get(module);
  if (exact) return exact;
  const hits = [...idx.modules.entries()].filter(([qn]) => qn.endsWith(`.${module}`));
  return hits.length === 1 ? hits[0]![1] : undefined;
}

/** 在 module 里找 names；names 的前几段也可能是子模块 */
function findInModule(idx: SymbolIndex, module: string, names: string[]): ExtractedSymbol | undefined {
  for (let k = 0; k < names.length; k++) {
    const file = findModuleFile(idx, [module, ...names.slice(0, k)].filter(Boolean).join('.'));
    const hit = file ? idx.byFile.get(file)?.get(names.slice(k).join('.')) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

function resolveRouteTarget(idx: SymbolIndex, file: ExtractedFile, target: string[]): ExtractedSymbol | undefined {
  const [head, ...rest] = target;
  const binding = head ? file.imports.get(head) : undefined;
  if (binding) {
    const names = binding.name ? [...binding.name.split('.'), ...rest] : rest;
    const hit = findInModule(idx, binding.module, names);
    if (hit) return hit;
  }
  const local = idx.byFile.get(file.path)?.get(target.join('.'));
  if (local) return local;
  const byName = idx.byName.get(target[target.length - 1] ?? '') ?? [];
  return byName.length === 1 ? byName[0] : undefined;
}

/** 把各 urls.py 的路由对应到处理函数或视图类，生成 Django 入口 */
export function resolveDjangoEntries(files: ExtractedFile[]): ExtractedEntry[] {
  const withRoutes = files.filter((f) => f.djangoRoutes.length > 0);
  if (withRoutes.length === 0) return [];
  const idx = buildIndex(files);
  const entries: ExtractedEntry[] = [];
  for (const f of withRoutes) {
    for (const r of f.djangoRoutes) {
      const sym = resolveRouteTarget(idx, f, r.target);
      if (sym) entries.push({ symbolId: sym.id, kind: 'http', framework: 'django', detail: { ...r.detail, urls: f.path } });
    }
  }
  return entries;
}
