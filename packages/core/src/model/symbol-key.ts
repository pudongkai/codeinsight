import { createHash } from 'node:crypto';

export type SymbolKind =
  | 'module'
  | 'class'
  | 'function'
  | 'method'
  | 'interface'
  | 'enum';

export interface SymbolKeyParts {
  path: string;
  kind: SymbolKind | string;
  qualifiedName: string;
  /** 只用于区分重载：Python 为空字符串 */
  signature: string;
}

const SEP = '#';

/** symbol_key 不含行号，保证同一符号跨版本稳定。 */
export function makeSymbolKey(parts: SymbolKeyParts): string {
  return [parts.path, parts.kind, parts.qualifiedName, parts.signature].join(SEP);
}

/**
 * path、kind、signature 都不含 `#`；qualified_name 可能带 `#2` 这样的去重后缀，
 * 所以按"第一段 path、第二段 kind、最后一段 signature、中间是 qualified_name"解析。
 */
export function parseSymbolKey(key: string): SymbolKeyParts {
  const first = key.indexOf(SEP);
  const second = key.indexOf(SEP, first + 1);
  const last = key.lastIndexOf(SEP);
  if (first < 0 || second < 0 || last <= second) throw new Error(`invalid symbol key: ${key}`);
  return {
    path: key.slice(0, first),
    kind: key.slice(first + 1, second),
    qualifiedName: key.slice(second + 1, last),
    signature: key.slice(last + 1),
  };
}

export function symbolIdFromKey(key: string): string {
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

/**
 * 同一快照里 symbol_key 重复时按出现顺序给 qualified_name 加 `#2`、`#3` 后缀。
 * 输入按出现顺序排列，返回去重后的 qualified_name 列表。
 */
export function dedupeQualifiedNames<T extends SymbolKeyParts>(items: T[]): T[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = makeSymbolKey(item);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? item : { ...item, qualifiedName: `${item.qualifiedName}#${n}` };
  });
}
