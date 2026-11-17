import type { Node } from 'web-tree-sitter';

const DOC_MAX = 500;

/** 字符串字面量（解释型或反引号）去掉两侧引号后的内容；不是字符串时为 undefined */
export function goStringValue(node: Node | null | undefined): string | undefined {
  if (node?.type !== 'interpreted_string_literal' && node?.type !== 'raw_string_literal') return undefined;
  return node.text.slice(1, -1);
}

/** 前一个兄弟节点是紧挨着（上一行结束）的 `//` 注释时返回它 */
function adjacentLineComment(node: Node, row: number): Node | undefined {
  const prev = node.previousSibling;
  if (prev?.type !== 'comment' || !prev.text.startsWith('//')) return undefined;
  return prev.endPosition.row === row - 1 ? prev : undefined;
}

/** 声明前紧挨着的连续 `//` 注释行，去掉 `//` 前缀后按行拼接；没有时为 null */
export function goDocComment(decl: Node): string | null {
  const lines: string[] = [];
  let row = decl.startPosition.row;
  let cur: Node = decl;
  for (let c = adjacentLineComment(cur, row); c; c = adjacentLineComment(cur, row)) {
    lines.unshift(c.text.replace(/^\/\/ ?/, ''));
    row = c.startPosition.row;
    cur = c;
  }
  if (lines.length === 0) return null;
  return lines.join('\n').trim().slice(0, DOC_MAX);
}

/** 节点原文从开头到 end 之前的部分，空白折叠成一个空格 */
export function collapsedHead(node: Node, end: Node | null): string {
  const text = end ? node.text.slice(0, end.startIndex - node.startIndex) : node.text;
  return text.replace(/\s+/g, ' ').trim();
}

/** 函数或方法声明去掉函数体后的文字，如 `func (r *T) Name(a int) (string, error)` */
export function goFuncSignature(decl: Node): string {
  return collapsedHead(decl, decl.childForFieldName('body'));
}

/** 方法声明接收者的类型名（去掉指针和类型参数）；取不到时为 undefined */
export function receiverTypeName(decl: Node): string | undefined {
  const param = decl.childForFieldName('receiver')?.namedChildren.find((n) => n.type === 'parameter_declaration');
  let t = param?.childForFieldName('type') ?? null;
  while (t && (t.type === 'pointer_type' || t.type === 'parenthesized_type')) t = t.namedChildren[0] ?? null;
  if (t?.type === 'generic_type') t = t.childForFieldName('type');
  return t?.type === 'type_identifier' ? t.text : undefined;
}

/** 接收者变量名；匿名接收者为 undefined */
export function receiverVarName(decl: Node): string | undefined {
  const param = decl.childForFieldName('receiver')?.namedChildren.find((n) => n.type === 'parameter_declaration');
  const name = param?.childForFieldName('name')?.text;
  return name && name !== '_' ? name : undefined;
}
