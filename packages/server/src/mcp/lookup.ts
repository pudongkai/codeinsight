import { symbolIdFromKey } from '@codeinsight/core';
import type { Store, SymbolRow } from '@codeinsight/core';

export type Lookup = { kind: 'found'; symbol: SymbolRow } | { kind: 'ambiguous'; candidates: SymbolRow[] } | { kind: 'not_found' };

/** 去掉重复定义的 `#2` 后缀后比较 qualified_name */
function baseQualifiedName(s: SymbolRow): string {
  return s.qualifiedName.replace(/#\d+$/, '');
}

/**
 * Rust 的 `::` 限定名是否指向这个符号：先比完整的 qualified_name；查询以 `crate::` 开头时第一段可以是任意 crate 名；
 * suffix 为 true 时只要 qualified_name 以 `::<查询>` 结尾（如 `Service::create`）
 */
function matchesRustPath(s: SymbolRow, q: string, suffix: boolean): boolean {
  const base = baseQualifiedName(s);
  if (base === q) return true;
  if (q.startsWith('crate::')) {
    const rest = q.slice('crate::'.length);
    return base.endsWith(`::${rest}`) && !base.slice(0, -(rest.length + 2)).includes('::');
  }
  return suffix && base.endsWith(`::${q}`);
}

/** 按限定名过滤候选：`::` 先找完全匹配（含 `crate::` 开头），没有时按后缀匹配；`.` 只认完全相等 */
function filterQualified(rows: SymbolRow[], q: string, separator: string): SymbolRow[] {
  if (separator === '.') return rows.filter((s) => baseQualifiedName(s) === q);
  const exact = rows.filter((s) => matchesRustPath(s, q, false));
  return exact.length > 0 ? exact : rows.filter((s) => matchesRustPath(s, q, true));
}

/**
 * 按 symbol_key（含 `#`）、名字或 qualified_name（如 `Service.run`、Rust 的 `shop_core::order::Service::create`、
 * `crate::order::Service::create`、`Service::create`）找符号，不含 module 符号。名字对应多个符号时不猜，返回候选列表。
 */
export function lookupSymbol(store: Store, snapshotId: number, query: string): Lookup {
  const q = query.trim();
  if (q.includes('#')) {
    const sym = store.getSymbol(snapshotId, symbolIdFromKey(q));
    return sym ? { kind: 'found', symbol: sym } : { kind: 'not_found' };
  }
  const separator = q.includes('::') ? '::' : q.includes('.') ? '.' : undefined;
  const name = separator ? q.split(separator).at(-1)! : q;
  let rows = store.findSymbolsByName(snapshotId, name).filter((s) => s.kind !== 'module');
  if (separator) rows = filterQualified(rows, q, separator);
  rows.sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine);
  if (rows.length === 0) return { kind: 'not_found' };
  if (rows.length === 1) return { kind: 'found', symbol: rows[0]! };
  return { kind: 'ambiguous', candidates: rows };
}
