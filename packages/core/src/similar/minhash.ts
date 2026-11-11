import { pushTo } from '../util/collections.js';

/**
 * MinHash + LSH：全库扫描时用来找函数体可能相似的组合，只对命中的组合算精确的 shingle Jaccard。
 * 128 个 hash 分成 32 个 band、每个 band 4 行：命中概率为 1 - (1 - J^4)^32，
 * 相似度为候选阈值 0.5 时约 0.87，0.7 以上时接近 1。
 */
export const MINHASH_SIZE = 128;
export const LSH_BANDS = 32;
const ROWS_PER_BAND = MINHASH_SIZE / LSH_BANDS;

/** FNV-1a 32 位 */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** murmur3 的 fmix32，把种子异或后的值打散，作为一族独立的 hash 函数 */
function mix(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const SEEDS = Array.from({ length: MINHASH_SIZE }, (_, i) => mix(0x9e3779b9 + i * 0x7f4a7c15));

export function minhash(set: Set<string>): Uint32Array {
  const sig = new Uint32Array(MINHASH_SIZE).fill(0xffffffff);
  for (const s of set) {
    const base = hashString(s);
    for (let i = 0; i < MINHASH_SIZE; i++) {
      const v = mix(base ^ SEEDS[i]!);
      if (v < sig[i]!) sig[i] = v;
    }
  }
  return sig;
}

/** LSH 索引：同一个 band 的 4 个值完全相同的条目落进同一个桶 */
export class LshIndex<T> {
  private readonly buckets = new Map<string, T[]>();

  private static bandKeys(sig: Uint32Array): string[] {
    const keys: string[] = [];
    for (let b = 0; b < LSH_BANDS; b++) {
      keys.push(`${b}:${Array.from(sig.subarray(b * ROWS_PER_BAND, (b + 1) * ROWS_PER_BAND)).join(',')}`);
    }
    return keys;
  }

  add(sig: Uint32Array, item: T): void {
    for (const key of LshIndex.bandKeys(sig)) pushTo(this.buckets, key, item);
  }

  /** 至少有一个 band 相同的条目（去重） */
  query(sig: Uint32Array): Set<T> {
    const out = new Set<T>();
    for (const key of LshIndex.bandKeys(sig)) for (const item of this.buckets.get(key) ?? []) out.add(item);
    return out;
  }
}
