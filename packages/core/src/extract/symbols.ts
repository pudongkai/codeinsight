import { dedupeQualifiedNames, makeSymbolKey, symbolIdFromKey } from '../model/symbol-key.js';
import type { SymbolRow } from '../model/types.js';
import type { ExtractedSymbol } from './types.js';

/** 去重前的符号；parent 为父符号在列表里的下标 */
export interface RawSymbol extends Omit<ExtractedSymbol, 'id' | 'symbolKey' | 'parentId'> {
  parent: number | null;
}

/** 按出现顺序去重 qualified_name（重复的加 `#2` 后缀）后计算 symbol_key、id 和 parent_id */
export function finalizeSymbols(raw: RawSymbol[]): ExtractedSymbol[] {
  const deduped = dedupeQualifiedNames(raw);
  const ids = deduped.map((s) => symbolIdFromKey(makeSymbolKey(s)));
  return deduped.map(({ parent, ...rest }, i): ExtractedSymbol => ({
    ...rest,
    symbolKey: makeSymbolKey(rest),
    id: ids[i]!,
    parentId: parent === null ? null : ids[parent]!,
  }));
}

/**
 * 还原文件时以库里的符号为准（含跨文件补上的父符号），名字位置取自重新提取的符号：
 * 按 id 对应，对不上时按 `名字@起始行` 对应
 */
export function restoredSymbols(fresh: ExtractedSymbol[], rows: Omit<SymbolRow, 'snapshotId'>[]): ExtractedSymbol[] {
  const byId = new Map(fresh.map((s) => [s.id, s]));
  const byName = new Map(fresh.map((s) => [`${s.name}@${s.startLine}`, s]));
  const ordered = [...rows].sort((a, b) => (a.kind === 'module' ? -1 : b.kind === 'module' ? 1 : a.startLine - b.startLine));
  return ordered.map((r): ExtractedSymbol => {
    const f = byId.get(r.id) ?? byName.get(`${r.name}@${r.startLine}`);
    return { ...r, nameLine: f?.nameLine ?? (r.kind === 'module' ? 0 : r.startLine - 1), nameCol: f?.nameCol ?? 0 };
  });
}
