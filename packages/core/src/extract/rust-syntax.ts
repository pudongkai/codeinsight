import type { Node } from 'web-tree-sitter';
import { stripDedupSuffix } from '../model/symbol-key.js';

const DOC_MAX = 500;

const COMMENTS = new Set(['line_comment', 'block_comment']);

/** 去掉原始标识符的 `r#` 前缀 */
export function stripRaw(name: string): string {
  return name.startsWith('r#') ? name.slice(2) : name;
}

/** 文档注释节点（`///`、`/** *\/`、`//!`、`/*! *\/`）的正文，按行去掉前导 `*` */
function docText(comment: Node): string {
  const doc = comment.childForFieldName('doc')?.text ?? '';
  return doc.split('\n').map((l) => l.replace(/^\s*\*? ?/, '').trimEnd()).join('\n').trim();
}

function isOuterDoc(n: Node): boolean {
  return COMMENTS.has(n.type) && n.childForFieldName('outer') !== null;
}

function isInnerDoc(n: Node): boolean {
  return COMMENTS.has(n.type) && n.childForFieldName('inner') !== null;
}

function finishDoc(parts: string[]): string | null {
  const text = parts.filter(Boolean).join('\n').trim();
  return text ? text.slice(0, DOC_MAX) : null;
}

/** 项前面的属性（`#[...]`），按出现顺序；中间的注释跳过 */
export function itemAttributes(item: Node): Node[] {
  const out: Node[] = [];
  for (let p = item.previousNamedSibling; p && (p.type === 'attribute_item' || COMMENTS.has(p.type)); p = p.previousNamedSibling) {
    if (p.type === 'attribute_item') out.unshift(p);
  }
  return out;
}

/** 项前面紧挨着的 `///` 行或 `/** *\/`（中间允许属性行）；没有时为 null */
export function rustDocComment(item: Node): string | null {
  const parts: string[] = [];
  let row = item.startPosition.row;
  for (let p = item.previousNamedSibling; p; p = p.previousNamedSibling) {
    if (p.endPosition.row < row - 1) break;
    if (p.type === 'attribute_item') {
      row = p.startPosition.row;
      continue;
    }
    if (!isOuterDoc(p)) break;
    parts.unshift(docText(p));
    row = p.startPosition.row;
  }
  return finishDoc(parts);
}

/** 文件开头的 `//!` 行（中间允许内部属性和普通注释） */
export function rustModuleDoc(root: Node): string | null {
  const parts: string[] = [];
  for (const n of root.namedChildren) {
    if (isInnerDoc(n)) parts.push(docText(n));
    else if (n.type !== 'inner_attribute_item' && !COMMENTS.has(n.type)) break;
  }
  return finishDoc(parts);
}

/** 属性的路径文字，如 `derive`、`tokio::main` */
export function attributePath(attrItem: Node): string {
  const attr = attrItem.namedChildren.find((n) => n.type === 'attribute');
  const head = attr?.namedChildren[0];
  return head && head !== attr?.childForFieldName('arguments') ? head.text.replace(/\s+/g, '') : '';
}

/** 属性的参数文字（含括号）；没有参数时为空字符串 */
export function attributeArgs(attrItem: Node): string {
  const attr = attrItem.namedChildren.find((n) => n.type === 'attribute');
  return attr?.childForFieldName('arguments')?.text ?? '';
}

/** `#[test]`、`#[tokio::test]` 等以 test 结尾的属性 */
export function isTestAttribute(attrItem: Node): boolean {
  return /test$/.test(attributePath(attrItem).split('::').pop() ?? '');
}

/** `#[cfg(test)]`（含 `all(test, ...)`、`any(test, ...)`）；字符串里的 test 和 `not(test)` 不算 */
export function isCfgTest(attrItem: Node): boolean {
  if (attributePath(attrItem) !== 'cfg') return false;
  const args = attributeArgs(attrItem).replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\bnot\s*\(\s*test\s*\)/g, '');
  return /\btest\b/.test(args);
}

/** 节点原文从开头到 end 之前的部分，空白折叠成一个空格，去掉结尾的 `;` */
export function rustHead(node: Node, end: Node | null): string {
  const text = end ? node.text.slice(0, end.startIndex - node.startIndex) : node.text;
  return text.replace(/\s+/g, ' ').trim().replace(/\s*;$/, '');
}

/** impl 目标类型的名字：去掉引用、泛型参数和路径前缀，`&'a Wrapper<T>` → Wrapper，`dyn Repo<T> + Send` → Repo */
export function implTypeName(type: Node | null): string {
  let t = type;
  while (t && (t.type === 'reference_type' || t.type === 'pointer_type')) t = t.childForFieldName('type');
  if (t?.type === 'bounded_type') t = t.namedChildren[0] ?? null;
  if (t?.type === 'dynamic_type') t = t.childForFieldName('trait');
  if (t?.type === 'generic_type') t = t.childForFieldName('type');
  if (t?.type === 'scoped_type_identifier') t = t.childForFieldName('name');
  return t ? t.text.replace(/\s+/g, '') : '';
}

/** trait 的规范化写法：去掉所有空白，逗号后加一个空格 */
export function normalizeTraitText(text: string): string {
  return text.replace(/\s+/g, '').replace(/,/g, ', ');
}

/** 字符串字面量（普通或原始）的内容；不是字符串时为 undefined */
export function rustStringValue(node: Node | null | undefined): string | undefined {
  if (node?.type !== 'string_literal' && node?.type !== 'raw_string_literal') return undefined;
  return node.namedChildren.filter((c) => c.type === 'string_content').map((c) => c.text).join('');
}

/** 路径节点（scoped_identifier 等）展开成各段文字；`::std::x` 开头的空段跳过 */
export function pathSegments(node: Node | null): string[] {
  if (!node) return [];
  if (node.type === 'scoped_identifier' || node.type === 'scoped_type_identifier') {
    return [...pathSegments(node.childForFieldName('path')), ...segmentText(node.childForFieldName('name'))];
  }
  return segmentText(node);
}

function segmentText(node: Node | null): string[] {
  return node ? [stripRaw(node.text)] : [];
}

/**
 * `self`/`super` 开头的路径换成 `crate` 开头；modPath 为路径所在的完整模块路径（文件模块加内联 mod）。
 * 其他路径原样返回；`super` 超出 crate 根时为 undefined
 */
export function canonicalRustPath(segments: readonly string[], modPath: readonly string[]): string[] | undefined {
  if (segments[0] === 'self') return ['crate', ...modPath, ...segments.slice(1)];
  if (segments[0] !== 'super') return [...segments];
  let up = 0;
  while (segments[up] === 'super') up++;
  if (up > modPath.length) return undefined;
  return ['crate', ...modPath.slice(0, modPath.length - up), ...segments.slice(up)];
}

const PATH_LEAVES = new Set(['identifier', 'type_identifier', 'field_identifier', 'self', 'super', 'crate', 'metavariable']);

/**
 * 表达式或类型里的路径展开成各段，去掉泛型参数和 turbofish：`a::b::f`、`Vec::<u8>::new`、`f::<T>`、`Foo<T>`；
 * `<T as Trait>::m` 取 trait 的路径，`<T>::m` 取 T 的路径。不是路径时为 undefined
 */
export function rustPathOf(node: Node | null | undefined): string[] | undefined {
  if (!node) return undefined;
  if (PATH_LEAVES.has(node.type)) return [stripRaw(node.text)];
  switch (node.type) {
    case 'scoped_identifier':
    case 'scoped_type_identifier': {
      const name = node.childForFieldName('name');
      const pathNode = node.childForFieldName('path');
      const head = pathNode ? rustPathOf(pathNode) : [];
      return head && name ? [...head, stripRaw(name.text)] : undefined;
    }
    case 'generic_function':
      return rustPathOf(node.childForFieldName('function'));
    case 'generic_type':
      return rustPathOf(node.childForFieldName('type'));
    case 'bracketed_type': {
      const inner = node.namedChildren[0];
      return rustPathOf(inner?.type === 'qualified_type' ? inner.childForFieldName('alias') : inner);
    }
    default:
      return undefined;
  }
}

/** trait impl 的方法：qualifiedName 形如 `模块::<Type as Trait>::m` */
export function isRustTraitImplMethod(s: { qualifiedName: string; name: string }): boolean {
  const qn = stripDedupSuffix(s.qualifiedName);
  return qn.endsWith(`>::${s.name}`) && qn.includes(' as ');
}
