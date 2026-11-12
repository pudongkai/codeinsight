import type { Node } from 'web-tree-sitter';
import { buildIndex, dottedParts, findModuleFile, type SymbolIndex } from './entries.js';
import type { BaseVarKind, ClassHint, ExtractedFile, ExtractedSymbol, ImportBinding, ModelMatch } from './types.js';

/**
 * 数据模型类识别（Python）。
 * 提取每个文件时只记录类的基类、装饰器和模块顶层的模型基类变量（ClassHint、baseVars），
 * 全部文件提取完后再判断：基类先在项目内查找（同文件定义、import 绑定，跟随 `__init__.py` 的再导出），
 * 是项目内的类就递归判断它是不是模型或模型基类；查不到项目内定义时按完整名字匹配已知的框架基类；
 * 既没有定义也没有 import（如 `from x import *`）的名字，快照里只有一个同名类时用它。
 */

/** import 链、再导出链的最大跟随层数，防止循环导入 */
const MAX_REEXPORT_DEPTH = 5;

/** 按基类完整名字（点分）匹配已知框架基类，返回继承它的类会是什么 */
function knownBase(full: string[]): ModelMatch | undefined {
  const last = full[full.length - 1];
  if (last === 'BaseModel' || last === 'RootModel' || last === 'GenericModel') return { kind: 'pydantic', base: false };
  if (last === 'SQLModel') return { kind: 'sqlmodel', base: false };
  if (last === 'DeclarativeBase' || last === 'DeclarativeBaseNoMeta') return { kind: 'sqlalchemy', base: true };
  if (last === 'TypedDict') return { kind: 'typeddict', base: false };
  if (last === 'NamedTuple') return { kind: 'namedtuple', base: false };
  if (last === 'Model' && full.length >= 2) {
    if (full[full.length - 2] === 'models') return { kind: 'django', base: false };
    if (full.length === 2 && full[0] === 'db') return { kind: 'sqlalchemy', base: false };
  }
  return undefined;
}

const ATTRS_DECORATORS = new Set(['attr.s', 'attr.attrs', 'attr.define', 'attr.frozen', 'attr.mutable', 'attr.dataclass', 'attrs.define', 'attrs.frozen', 'attrs.mutable']);

/** 按装饰器完整名字识别：dataclass（含 pydantic.dataclasses.dataclass）、attrs，以及 SQLAlchemy 的 `@as_declarative` 基类 */
function knownDecorator(full: string[]): ModelMatch | undefined {
  const last = full[full.length - 1];
  if (last === 'dataclass' && full[0] !== 'attr') return { kind: 'dataclass', base: false };
  if (ATTRS_DECORATORS.has(full.join('.'))) return { kind: 'attrs', base: false };
  if (last === 'as_declarative') return { kind: 'sqlalchemy', base: true };
  return undefined;
}

// ---- 提取单个文件时收集线索 ----

/** 基类列表里的点分名字；`Generic[T]`、`BaseModel[T]` 这样的下标取被下标的名字，关键字参数（metaclass=、total=）忽略 */
function baseNames(def: Node): string[][] {
  const out: string[][] = [];
  for (const arg of def.childForFieldName('superclasses')?.namedChildren ?? []) {
    const node = arg.type === 'subscript' ? arg.childForFieldName('value') : arg;
    const parts = dottedParts(node);
    if (parts) out.push(parts);
  }
  return out;
}

function decoratorNames(decorators: Node[]): string[][] {
  return decorators.flatMap((d) => {
    const expr = d.firstNamedChild;
    const parts = dottedParts(expr?.type === 'call' ? expr.childForFieldName('function') : expr);
    return parts ? [parts] : [];
  });
}

/** 一个文件里所有类的基类和装饰器；defs 与 symbols 一一对应（非类为 undefined） */
export function classHints(symbols: ExtractedSymbol[], defs: (Node | undefined)[], decorators: Node[][]): ClassHint[] {
  const out: ClassHint[] = [];
  symbols.forEach((s, i) => {
    const def = defs[i];
    if (s.kind !== 'class' || !def) return;
    out.push({ symbolId: s.id, bases: baseNames(def), decorators: decoratorNames(decorators[i] ?? []) });
  });
  return out;
}

const BASE_VAR_CALLS: Record<string, BaseVarKind> = { declarative_base: 'declarative', generate_base: 'declarative', SQLAlchemy: 'flask_db' };

/** 模块顶层的 `Base = declarative_base()`、`db = SQLAlchemy(app)`（也接受带类型注解的赋值） */
export function baseVars(root: Node): Map<string, BaseVarKind> {
  const out = new Map<string, BaseVarKind>();
  for (const stmt of root.namedChildren) {
    const assign = stmt.type === 'expression_statement' ? stmt.firstNamedChild : null;
    if (assign?.type !== 'assignment') continue;
    const left = assign.childForFieldName('left');
    const right = assign.childForFieldName('right');
    if (left?.type !== 'identifier' || right?.type !== 'call') continue;
    const fn = dottedParts(right.childForFieldName('function'));
    const kind = fn ? BASE_VAR_CALLS[fn[fn.length - 1]!] : undefined;
    if (kind) out.set(left.text, kind);
  }
  return out;
}

// ---- 全部文件提取完后判断 ----

/** 名字查找结果：项目内的类、项目内的模型基类变量，或项目外的名字（完整点分名，unbound 表示没有任何 import 或定义） */
type Resolved =
  | { cls: ExtractedSymbol }
  | { baseVar: BaseVarKind; rest: string[] }
  | { external: string[]; unbound: boolean };

interface ModelIndex extends SymbolIndex {
  files: Map<string, ExtractedFile>;
  /** 类 id → 类的线索和所在文件 */
  classes: Map<string, { hint: ClassHint; file: ExtractedFile }>;
  memo: Map<string, ModelMatch | null>;
}

/**
 * 在 path 文件的命名空间里查 names：类定义、模型基类变量，或 import 进来的名字（继续跟随）。
 * self 为正在判断的类：`class BaseModel(BaseModel)` 这种同名覆盖时基类指 import 进来的那个，不是它自己
 */
function lookupIn(idx: ModelIndex, path: string, names: string[], depth: number, self?: string): Resolved | undefined {
  const sym = idx.byFile.get(path)?.get(names.join('.'));
  if (sym?.kind === 'class' && sym.id !== self) return { cls: sym };
  const v = idx.files.get(path)?.baseVars?.get(names[0]!);
  if (v) return { baseVar: v, rest: names.slice(1) };
  const binding = idx.files.get(path)?.imports.get(names[0]!);
  return binding && depth < MAX_REEXPORT_DEPTH ? resolveBinding(idx, binding, names.slice(1), depth + 1) : undefined;
}

/** import 绑定指向的名字；绑定的模块不在项目里（或项目里找不到这个名字）时返回项目外的完整名字 */
function resolveBinding(idx: ModelIndex, binding: ImportBinding, rest: string[], depth: number): Resolved {
  const names = binding.name ? [...binding.name.split('.'), ...rest] : rest;
  for (let k = 0; k < names.length; k++) {
    const file = findModuleFile(idx, [binding.module, ...names.slice(0, k)].join('.'));
    const hit = file ? lookupIn(idx, file, names.slice(k), depth) : undefined;
    if (hit) return hit;
  }
  return { external: [...binding.module.split('.'), ...names], unbound: false };
}

function classMatch(idx: ModelIndex, id: string, visiting: Set<string>): ModelMatch | null {
  const cached = idx.memo.get(id);
  if (cached !== undefined) return cached;
  const entry = idx.classes.get(id);
  if (!entry || visiting.has(id)) return null;
  visiting.add(id);
  const fromBases = entry.hint.bases.map((b) => baseMatch(idx, entry.file, b, id, visiting)).find((m) => m !== undefined);
  const result = fromBases ?? decoratorMatch(entry.file, entry.hint) ?? null;
  visiting.delete(id);
  idx.memo.set(id, result);
  return result;
}

/** 项目内的模型或模型基类的子类是模型 */
function subclassOf(idx: ModelIndex, id: string, visiting: Set<string>): ModelMatch | undefined {
  const m = classMatch(idx, id, visiting);
  return m ? { kind: m.kind, base: false } : undefined;
}

/** 继承 parts 这个基类的类会是什么：模型、模型基类（继承 DeclarativeBase 的类），或都不是（undefined） */
function baseMatch(idx: ModelIndex, file: ExtractedFile, parts: string[], self: string, visiting: Set<string>): ModelMatch | undefined {
  const r = lookupIn(idx, file.path, parts, 0, self) ?? { external: parts, unbound: true };
  if ('cls' in r) return subclassOf(idx, r.cls.id, visiting);
  if ('baseVar' in r) {
    const ok = r.baseVar === 'declarative' ? r.rest.length === 0 : r.rest.length === 1 && r.rest[0] === 'Model';
    return ok ? { kind: 'sqlalchemy', base: false } : undefined;
  }
  const known = knownBase(r.external);
  if (known || !r.unbound) return known;
  const sameName = (idx.byName.get(parts[parts.length - 1]!) ?? []).filter((s) => s.kind === 'class' && s.id !== self);
  return sameName.length === 1 ? subclassOf(idx, sameName[0]!.id, visiting) : undefined;
}

function decoratorMatch(file: ExtractedFile, hint: ClassHint): ModelMatch | undefined {
  for (const parts of hint.decorators) {
    const binding = file.imports.get(parts[0]!);
    const full = binding ? [...binding.module.split('.'), ...(binding.name ? binding.name.split('.') : []), ...parts.slice(1)] : parts;
    const m = knownDecorator(full);
    if (m) return m;
  }
  return undefined;
}

/** 判断全部文件里的类是不是数据模型类，结果写进符号的 modelKind（模型基类本身不写） */
export function resolveModels(files: ExtractedFile[]): number {
  const idx: ModelIndex = { ...buildIndex(files), files: new Map(), classes: new Map(), memo: new Map() };
  for (const f of files) {
    idx.files.set(f.path, f);
    for (const hint of f.classes ?? []) idx.classes.set(hint.symbolId, { hint, file: f });
  }
  let count = 0;
  for (const f of files) {
    for (const s of f.symbols) {
      if (s.kind !== 'class' || !idx.classes.has(s.id)) continue;
      const m = classMatch(idx, s.id, new Set());
      s.modelKind = m && !m.base ? m.kind : null;
      if (s.modelKind) count++;
    }
  }
  return count;
}
