import { symbolIdFromKey } from '@codeinsight/core';
import type { Store, SymbolRow } from '@codeinsight/core';

export type Lookup = { kind: 'found'; symbol: SymbolRow } | { kind: 'ambiguous'; candidates: SymbolRow[] } | { kind: 'not_found' };

/** 去掉重复定义的 `#2` 后缀后比较 qualified_name */
function baseQualifiedName(s: SymbolRow): string {
  return s.qualifiedName.replace(/#\d+$/, '');
}

/**
 * 按 symbol_key（含 `#`）、名字或 qualified_name（如 `Service.run`）找符号，不含 module 符号。
 * 名字对应多个符号时不猜，返回候选列表。
 */
export function lookupSymbol(store: Store, snapshotId: number, query: string): Lookup {
  const q = query.trim();
  if (q.includes('#')) {
    const sym = store.getSymbol(snapshotId, symbolIdFromKey(q));
    return sym ? { kind: 'found', symbol: sym } : { kind: 'not_found' };
  }
  const name = q.split('.').at(-1)!;
  let rows = store.findSymbolsByName(snapshotId, name).filter((s) => s.kind !== 'module');
  if (q.includes('.')) rows = rows.filter((s) => baseQualifiedName(s) === q);
  rows.sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine);
  if (rows.length === 0) return { kind: 'not_found' };
  if (rows.length === 1) return { kind: 'found', symbol: rows[0]! };
  return { kind: 'ambiguous', candidates: rows };
}
