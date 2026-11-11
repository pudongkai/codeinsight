import type { Node } from 'web-tree-sitter';
import { jaccard } from '../util/collections.js';

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

export const SHINGLE_SIZE = 5;

/** 归一化 token 序列的 k-gram shingle 集合；不足 k 个 token 时整个序列作为一个 shingle */
export function shingles(tokens: string[], k = SHINGLE_SIZE): Set<string> {
  const out = new Set<string>();
  if (tokens.length === 0) return out;
  if (tokens.length < k) {
    out.add(tokens.join('\u0001'));
    return out;
  }
  for (let i = 0; i + k <= tokens.length; i++) out.add(tokens.slice(i, i + k).join('\u0001'));
  return out;
}

/** 函数体相似度：shingle 集合的 Jaccard，两边都为空时为 0 */
export function bodySimilarity(a: string[], b: string[], k = SHINGLE_SIZE): number {
  return jaccard(shingles(a, k), shingles(b, k));
}
