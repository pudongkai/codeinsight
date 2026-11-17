import type { Node } from 'web-tree-sitter';
import { sha1 } from '../util/hash.js';
import { goDocComment, goFuncSignature, collapsedHead, goStringValue, receiverTypeName } from './go-syntax.js';
import { typeQualifiedName, type GoTypeContext } from './go-types.js';
import { GO_TOKENS, normalizeTokens } from './normalize.js';
import type { FileFlags } from './python.js';
import type { RawSymbol } from './symbols.js';
import type { GoStructTags } from './types.js';

/** 遍历顶层声明时的状态 */
export interface DeclWalk {
  path: string;
  flags: FileFlags;
  ctx: GoTypeContext;
  out: RawSymbol[];
  /** 本文件的类型名 → out 里的下标 */
  types: Map<string, number>;
  /** 方法在 out 里的下标 → 接收者类型名，遍历完后据此定父符号 */
  receivers: Map<number, string>;
  /** 函数和方法：out 里的下标 → 声明节点，之后收集调用点 */
  funcs: Map<number, Node>;
  /** struct 在 out 里的下标 → 标签信息 */
  structTags: Map<number, GoStructTags>;
  structFields: Record<string, Record<string, string>>;
  funcResults: Record<string, string>;
}

type SymbolFields = Pick<RawSymbol, 'kind' | 'name' | 'qualifiedName' | 'displaySignature' | 'parent' | 'bodyHash' | 'normTokens' | 'docstring'>;

/** range 为行号范围所在的节点，nameNode 为名字标识符 */
function push(w: DeclWalk, range: Node, nameNode: Node, fields: SymbolFields): number {
  w.out.push({
    ...fields,
    signature: '',
    path: w.path,
    startLine: range.startPosition.row + 1,
    endLine: range.endPosition.row + 1,
    isTest: w.flags.isTest,
    isGenerated: w.flags.isGenerated,
    nameLine: nameNode.startPosition.row,
    nameCol: nameNode.startPosition.column,
    modelKind: null,
  });
  return w.out.length - 1;
}

/** 第一个返回类型的节点：`(T, error)` 取 T，单个返回类型直接取 */
function firstResultType(decl: Node): Node | null {
  const result = decl.childForFieldName('result');
  if (result?.type !== 'parameter_list') return result;
  return result.namedChildren.find((n) => n.type === 'parameter_declaration')?.childForFieldName('type') ?? null;
}

/** 函数声明（function）或方法声明（method，父符号等遍历完按接收者类型确定） */
export function addFunc(w: DeclWalk, decl: Node): void {
  const nameNode = decl.childForFieldName('name');
  if (!nameNode) return;
  const recv = decl.type === 'method_declaration' ? receiverTypeName(decl) : undefined;
  if (decl.type === 'method_declaration' && !recv) return;
  const body = decl.childForFieldName('body');
  const idx = push(w, decl, nameNode, {
    kind: recv ? 'method' : 'function',
    name: nameNode.text,
    qualifiedName: recv ? `${w.ctx.packagePath}.${recv}.${nameNode.text}` : `${w.ctx.packagePath}.${nameNode.text}`,
    displaySignature: goFuncSignature(decl),
    parent: 0,
    bodyHash: sha1(decl.text),
    normTokens: body ? normalizeTokens([body], GO_TOKENS) : [],
    docstring: goDocComment(decl),
  });
  w.funcs.set(idx, decl);
  if (recv) {
    w.receivers.set(idx, recv);
    return;
  }
  const result = typeQualifiedName(firstResultType(decl), w.ctx);
  if (result) w.funcResults[nameNode.text] = result;
}

/** interface 里声明的方法，父符号为 interface */
function addInterfaceMethods(w: DeclWalk, iface: Node, parent: number): void {
  const owner = w.out[parent]!;
  for (const elem of iface.namedChildren) {
    const nameNode = elem.type === 'method_elem' ? elem.childForFieldName('name') : null;
    if (!nameNode) continue;
    push(w, elem, nameNode, {
      kind: 'method', name: nameNode.text, qualifiedName: `${owner.qualifiedName}.${nameNode.text}`,
      displaySignature: collapsedHead(elem, null), parent, bodyHash: sha1(elem.text), normTokens: [], docstring: goDocComment(elem),
    });
  }
}

/** 标签字符串里的键：`json:"id" gorm:"primaryKey"` → json、gorm */
function tagKeys(tag: string): string[] {
  return [...tag.matchAll(/([A-Za-z_][\w-]*):"/g)].map((m) => m[1]!);
}

/** 嵌入字段的名字：`*Base` → Base，`gorm.Model` → Model */
function embeddedName(type: Node): string | undefined {
  let t: Node | null = type;
  while (t?.type === 'pointer_type') t = t.namedChildren[0] ?? null;
  if (t?.type === 'generic_type') t = t.childForFieldName('type');
  if (t?.type === 'qualified_type') return t.childForFieldName('name')?.text;
  return t?.type === 'type_identifier' ? t.text : undefined;
}

/** struct 的字段类型和标签信息 */
function addStructFacts(w: DeclWalk, name: string, struct: Node, idx: number): void {
  const fields: Record<string, string> = {};
  const keys = new Set<string>();
  let gormModel = false;
  const list = struct.namedChildren.find((n) => n.type === 'field_declaration_list');
  for (const f of list?.namedChildren ?? []) {
    if (f.type !== 'field_declaration') continue;
    const type = f.childForFieldName('type');
    if (!type) continue;
    const names = f.childrenForFieldName('name').map((n) => n.text);
    if (names.length === 0) {
      const embedded = embeddedName(type);
      if (embedded) names.push(embedded);
      if (type.text.replace(/^\*/, '') === 'gorm.Model') gormModel = true;
    }
    const typeName = typeQualifiedName(type, w.ctx);
    if (typeName) for (const n of names) fields[n] = typeName;
    for (const k of tagKeys(goStringValue(f.childForFieldName('tag')) ?? '')) keys.add(k);
  }
  w.structFields[name] = fields;
  if (keys.size > 0 || gormModel) w.structTags.set(idx, { keys: [...keys], gormModel });
}

/** 一个 type_spec：struct 为 class，interface 为 interface（含声明的方法）；其他类型定义不建符号 */
export function addTypeSpec(w: DeclWalk, spec: Node, range: Node): void {
  const nameNode = spec.childForFieldName('name');
  const type = spec.childForFieldName('type');
  if (!nameNode || (type?.type !== 'struct_type' && type?.type !== 'interface_type')) return;
  const keyword = type.type === 'struct_type' ? 'struct' : 'interface';
  const idx = push(w, range, nameNode, {
    kind: keyword === 'struct' ? 'class' : 'interface',
    name: nameNode.text,
    qualifiedName: `${w.ctx.packagePath}.${nameNode.text}`,
    displaySignature: `type ${collapsedHead(spec, type)} ${keyword}`,
    parent: 0,
    bodyHash: sha1(spec.text),
    normTokens: [],
    docstring: goDocComment(range),
  });
  w.types.set(nameNode.text, idx);
  if (keyword === 'struct') addStructFacts(w, nameNode.text, type, idx);
  else addInterfaceMethods(w, type, idx);
}

/** type 声明：单独声明时行号范围和文档注释取整个声明，`type ( ... )` 分组声明取各自的 type_spec */
export function addTypeDeclaration(w: DeclWalk, decl: Node): void {
  const grouped = decl.children.some((c) => c.type === '(');
  for (const spec of decl.namedChildren) if (spec.type === 'type_spec') addTypeSpec(w, spec, grouped ? spec : decl);
}

/** 方法的父符号：本文件有接收者类型时为该类型，否则先挂在 module 上（跨文件处理时补） */
export function linkReceivers(w: DeclWalk): void {
  for (const [idx, recv] of w.receivers) w.out[idx]!.parent = w.types.get(recv) ?? 0;
}
