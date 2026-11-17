import type { Node } from 'web-tree-sitter';
import { jaccard } from '../util/collections.js';

/** 一种语言的 token 归一化规则：各类节点按节点类型列出 */
export interface TokenTable {
  /** 丢弃 */
  comments: ReadonlySet<string>;
  /** 整体保留原文 */
  strings: ReadonlySet<string>;
  /** 替换为 ID */
  identifiers: ReadonlySet<string>;
  /** 替换为 NUM */
  numbers: ReadonlySet<string>;
}

export const PYTHON_TOKENS: TokenTable = {
  comments: new Set(['comment']),
  strings: new Set(['string', 'concatenated_string']),
  identifiers: new Set(['identifier']),
  numbers: new Set(['integer', 'float']),
};

export const GO_TOKENS: TokenTable = {
  comments: new Set(['comment']),
  strings: new Set(['interpreted_string_literal', 'raw_string_literal', 'rune_literal']),
  identifiers: new Set(['identifier', 'field_identifier', 'type_identifier', 'package_identifier', 'label_name']),
  numbers: new Set(['int_literal', 'float_literal', 'imaginary_literal']),
};

/**
 * tree-sitter token 归一化，similar 和 moved 判断共用：
 * 标识符替换为 ID，数字替换为 NUM，注释丢弃，字符串字面量保留原文
 * （只有 SQL 不同的仓储样板代码不会被判成重复）。节点类型按语言取 table，默认 Python。
 */
export function normalizeTokens(nodes: Node[], table: TokenTable = PYTHON_TOKENS): string[] {
  const out: string[] = [];
  for (const n of nodes) collect(n, table, out);
  return out;
}

function collect(node: Node, table: TokenTable, out: string[]): void {
  const type = node.type;
  if (table.comments.has(type)) return;
  if (table.strings.has(type)) {
    out.push(node.text);
    return;
  }
  if (table.identifiers.has(type)) {
    out.push('ID');
    return;
  }
  if (table.numbers.has(type)) {
    out.push('NUM');
    return;
  }
  if (node.childCount === 0) {
    if (node.text.length > 0) out.push(node.text);
    return;
  }
  for (const child of node.children) if (child) collect(child, table, out);
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
