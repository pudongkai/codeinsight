import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExtractedFile } from '../extract/types.js';
import type { EdgeRow, FallbackReason } from '../model/types.js';

/** 外部索引工具（scip-go、rust-analyzer）不可用或运行失败、要回退到名称匹配时抛出，reason 记进边来源；at 为失败发生的时间（来自缓存时沿用缓存里的） */
export class ToolFallback extends Error {
  constructor(readonly reason: FallbackReason, message: string, readonly at?: number) {
    super(message);
  }
}

/** 快照里这些文件的源码，按文件路径 */
export async function readSnapshotSources(root: string, files: readonly ExtractedFile[]): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for (const f of files) sources.set(f.path, await readFile(path.join(root, f.path), 'utf8'));
  return sources;
}

/** 写日志用的边数统计：总数和各类边的数量 */
export function edgeCounts(edges: readonly EdgeRow[]): Record<string, number> {
  const out: Record<string, number> = { edges: edges.length, call: 0, import: 0, reference: 0 };
  for (const e of edges) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}
