import { shingles } from '../extract/normalize.js';
import type { SymbolRow } from '../model/types.js';
import type { SymbolChangeKind } from '../report/types.js';
import { groupBy, jaccard } from '../util/collections.js';

/** 函数体相似度达到这个值时，同名同类型的删除 + 新增可以配成 moved */
export const MOVED_MIN_SIMILARITY = 0.9;

export interface SymbolDiff {
  change: SymbolChangeKind;
  /** removed / modified / signature_changed / moved 时有值 */
  base?: SymbolRow;
  /** added / modified / signature_changed / moved 时有值 */
  head?: SymbolRow;
}

export interface DiffInput {
  /** 两个版本里参与比较的符号（已排除 module 符号） */
  base: SymbolRow[];
  head: SymbolRow[];
  /** 按需批量加载 norm_tokens，只对 moved 候选调用 */
  loadTokens(side: 'base' | 'head', ids: string[]): Map<string, string[]>;
}

interface Unmatched {
  removed: SymbolRow[];
  added: SymbolRow[];
}

/** 同一文件、类型、signature，qualified_name 去掉重复定义的 `#N` 后缀后相同的符号为一组 */
function slotOf(s: SymbolRow): string {
  return `${s.path}\0${s.kind}\0${s.qualifiedName.replace(/#\d+$/, '')}\0${s.signature}`;
}

/**
 * 组内配对：先配 body_hash 相同的，剩下的按出现顺序配对。
 * 同名重复定义删掉或插入一个时 `#N` 编号会错位，直接按 key 配会把没动过的定义报成修改。
 */
function pairWithinSlot(base: SymbolRow[], head: SymbolRow[]): { pairs: [SymbolRow, SymbolRow][]; removed: SymbolRow[]; added: SymbolRow[] } {
  const byLine = (a: SymbolRow, b: SymbolRow) => a.startLine - b.startLine;
  const used = new Set<SymbolRow>();
  const pairs: [SymbolRow, SymbolRow][] = [];
  const restBase: SymbolRow[] = [];
  const sortedHead = [...head].sort(byLine);
  for (const b of [...base].sort(byLine)) {
    const h = sortedHead.find((x) => !used.has(x) && x.bodyHash === b.bodyHash);
    if (h) {
      used.add(h);
      pairs.push([b, h]);
    } else restBase.push(b);
  }
  const restHead = sortedHead.filter((h) => !used.has(h));
  const n = Math.min(restBase.length, restHead.length);
  for (let i = 0; i < n; i++) pairs.push([restBase[i]!, restHead[i]!]);
  return { pairs, removed: restBase.slice(n), added: restHead.slice(n) };
}

/** 按 symbol_key 所在的组配对两个版本的符号：body_hash 或 display_signature 不同时为 modified */
function matchByKey(input: DiffInput): { diffs: SymbolDiff[]; rest: Unmatched } {
  const baseSlots = groupBy(input.base, slotOf);
  const headSlots = groupBy(input.head, slotOf);
  const diffs: SymbolDiff[] = [];
  const rest: Unmatched = { removed: [], added: [] };
  for (const slot of new Set([...baseSlots.keys(), ...headSlots.keys()])) {
    const r = pairWithinSlot(baseSlots.get(slot) ?? [], headSlots.get(slot) ?? []);
    for (const [b, h] of r.pairs) {
      if (h.bodyHash !== b.bodyHash || h.displaySignature !== b.displaySignature) diffs.push({ change: 'modified', base: b, head: h });
    }
    rest.removed.push(...r.removed);
    rest.added.push(...r.added);
  }
  return { diffs, rest };
}

/** qualified_name 相同、signature 不同（只在有重载的语言里出现，Python 的 signature 恒为空） */
function matchSignatureChanged(rest: Unmatched): { diffs: SymbolDiff[]; rest: Unmatched } {
  const slot = (s: SymbolRow) => `${s.path}\0${s.kind}\0${s.qualifiedName}`;
  const pool = new Map<string, SymbolRow[]>();
  for (const a of rest.added) pool.set(slot(a), [...(pool.get(slot(a)) ?? []), a]);
  const diffs: SymbolDiff[] = [];
  const removed: SymbolRow[] = [];
  const used = new Set<SymbolRow>();
  for (const r of rest.removed) {
    const a = pool.get(slot(r))?.find((x) => !used.has(x) && x.signature !== r.signature);
    if (!a) {
      removed.push(r);
      continue;
    }
    used.add(a);
    diffs.push({ change: 'signature_changed', base: r, head: a });
  }
  return { diffs, rest: { removed, added: rest.added.filter((a) => !used.has(a)) } };
}

/** 路径相似度：从头和从尾分别数相同的路径段，除以较长路径的段数 */
export function pathSimilarity(a: string, b: string): number {
  const pa = a.split('/');
  const pb = b.split('/');
  const n = Math.min(pa.length, pb.length);
  let prefix = 0;
  while (prefix < n && pa[prefix] === pb[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && pa[pa.length - 1 - suffix] === pb[pb.length - 1 - suffix]) suffix++;
  return (prefix + suffix) / Math.max(pa.length, pb.length);
}

interface MoveCandidate {
  removed: SymbolRow;
  added: SymbolRow;
  sameHash: boolean;
  similarity: number;
  pathScore: number;
  sameQualifiedName: boolean;
}

function candidate(removed: SymbolRow, added: SymbolRow, similarity: number): MoveCandidate {
  return {
    removed, added, similarity, sameHash: removed.bodyHash === added.bodyHash,
    pathScore: pathSimilarity(removed.path, added.path), sameQualifiedName: removed.qualifiedName === added.qualifiedName,
  };
}

/** kind、name、body_hash 都相同的组合，按 hash 分桶，不需要两两比较函数体 */
function sameHashCandidates(rest: Unmatched): MoveCandidate[] {
  const added = groupBy(rest.added, (a) => `${a.kind}\0${a.name}\0${a.bodyHash}`);
  return rest.removed.flatMap((r) => (added.get(`${r.kind}\0${r.name}\0${r.bodyHash}`) ?? []).map((a) => candidate(r, a, 1)));
}

/** 剩下的 kind、name 相同的组合里函数体相似度 ≥ 0.9 的；每个符号的 shingle 集合只算一次 */
function similarCandidates(rest: Unmatched, input: DiffInput): MoveCandidate[] {
  const added = groupBy(rest.added, (a) => `${a.kind}\0${a.name}`);
  const pairs = rest.removed.flatMap((r) => (added.get(`${r.kind}\0${r.name}`) ?? []).map((a): [SymbolRow, SymbolRow] => [r, a]));
  if (pairs.length === 0) return [];
  const baseTokens = input.loadTokens('base', [...new Set(pairs.map(([r]) => r.id))]);
  const headTokens = input.loadTokens('head', [...new Set(pairs.map(([, a]) => a.id))]);
  const cache = new Map<string, Set<string>>();
  const shingleSet = (side: string, id: string, tokens: Map<string, string[]>) => {
    let set = cache.get(side + id);
    if (!set) cache.set(side + id, (set = shingles(tokens.get(id) ?? [])));
    return set;
  };
  const out: MoveCandidate[] = [];
  for (const [r, a] of pairs) {
    const similarity = jaccard(shingleSet('b', r.id, baseTokens), shingleSet('h', a.id, headTokens));
    if (similarity >= MOVED_MIN_SIMILARITY) out.push(candidate(r, a, similarity));
  }
  return out;
}

/** body_hash 相同 > 相似度高 > 路径相似度高 > qualified_name 相同，最后按 key 保证结果稳定 */
function compareCandidates(x: MoveCandidate, y: MoveCandidate): number {
  return (
    Number(y.sameHash) - Number(x.sameHash) ||
    y.similarity - x.similarity ||
    y.pathScore - x.pathScore ||
    Number(y.sameQualifiedName) - Number(x.sameQualifiedName) ||
    x.removed.symbolKey.localeCompare(y.removed.symbolKey) ||
    x.added.symbolKey.localeCompare(y.added.symbolKey)
  );
}

/** 候选排序后贪心选取，每个符号只用一次 */
function pickGreedy(candidates: MoveCandidate[], used: Set<SymbolRow>): SymbolDiff[] {
  const diffs: SymbolDiff[] = [];
  for (const c of candidates.sort(compareCandidates)) {
    if (used.has(c.removed) || used.has(c.added)) continue;
    used.add(c.removed);
    used.add(c.added);
    diffs.push({ change: 'moved', base: c.removed, head: c.added });
  }
  return diffs;
}

/**
 * 删除和新增之间一对一配 moved：body_hash 相同的先配掉，剩下的再按函数体相似度配。
 * 两轮合起来等价于按"body_hash 相同 > 相似度高 > 路径相似度高"整体排序后贪心选取。
 */
function matchMoved(rest: Unmatched, input: DiffInput): { diffs: SymbolDiff[]; rest: Unmatched } {
  const used = new Set<SymbolRow>();
  const remaining = (): Unmatched => ({ removed: rest.removed.filter((r) => !used.has(r)), added: rest.added.filter((a) => !used.has(a)) });
  const diffs = pickGreedy(sameHashCandidates(rest), used);
  diffs.push(...pickGreedy(similarCandidates(remaining(), input), used));
  return { diffs, rest: remaining() };
}

/**
 * 函数级 diff：按 symbol_key 匹配两个版本的符号，得到 modified；
 * 剩下的删除和新增依次配 signature_changed、moved，配不上的保持 removed / added。
 */
export function diffSymbols(input: DiffInput): SymbolDiff[] {
  const byKey = matchByKey(input);
  const sig = matchSignatureChanged(byKey.rest);
  const moved = matchMoved(sig.rest, input);
  return [
    ...byKey.diffs,
    ...sig.diffs,
    ...moved.diffs,
    ...moved.rest.removed.map((base): SymbolDiff => ({ change: 'removed', base })),
    ...moved.rest.added.map((head): SymbolDiff => ({ change: 'added', head })),
  ];
}
