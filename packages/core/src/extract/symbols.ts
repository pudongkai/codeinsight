import { dedupeQualifiedNames, makeSymbolKey, symbolIdFromKey } from '../model/symbol-key.js';
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
