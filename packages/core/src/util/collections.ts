/** 往 `Map<K, V[]>` 里按 key 追加一项，key 不存在时新建数组 */
export function pushTo<K, V>(m: Map<K, V[]>, key: K, value: V): void {
  const list = m.get(key);
  if (list) list.push(value);
  else m.set(key, [value]);
}

/** 往 `Map<K, Set<V>>` 里按 key 加一项，key 不存在时新建集合 */
export function addToSet<K, V>(m: Map<K, Set<V>>, key: K, value: V): void {
  const set = m.get(key);
  if (set) set.add(value);
  else m.set(key, new Set([value]));
}

/** 按 keyOf 分组，组内和组间都保持输入顺序 */
export function groupBy<K, V>(items: Iterable<V>, keyOf: (v: V) => K): Map<K, V[]> {
  const out = new Map<K, V[]>();
  for (const v of items) pushTo(out, keyOf(v), v);
  return out;
}

/** 两个集合的 Jaccard 相似度，任一为空时为 0；遍历较小的集合 */
export function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
