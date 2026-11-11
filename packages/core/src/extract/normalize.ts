import type { Node } from 'web-tree-sitter';

/**
 * tree-sitter token 归一化，similar 和 moved 判断共用：
 * 标识符替换为 ID，数字替换为 NUM，注释丢弃，字符串字面量保留原文
 * （只有 SQL 不同的仓储样板代码不会被判成重复）。
 */
export function normalizeTokens(nodes: Node[]): string[] {
  const out: string[] = [];
  for (const n of nodes) collect(n, out);
  return out;
}

function collect(node: Node, out: string[]): void {
  switch (node.type) {
    case 'comment':
      return;
    case 'string':
    case 'concatenated_string':
      out.push(node.text);
      return;
    case 'identifier':
      out.push('ID');
      return;
    case 'integer':
    case 'float':
      out.push('NUM');
      return;
  }
  if (node.childCount === 0) {
    if (node.text.length > 0) out.push(node.text);
    return;
  }
  for (const child of node.children) if (child) collect(child, out);
}
