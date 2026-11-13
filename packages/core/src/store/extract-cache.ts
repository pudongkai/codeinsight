import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { immediateTransaction } from './transaction.js';

type Row = Record<string, SQLInputValue>;

/** 一次 IN 查询最多带这么多个 key，避免单条语句参数过大 */
const LOOKUP_BATCH = 500;

export interface ExtractCacheEntry {
  key: string;
  path: string;
  /** 单个文件的提取结果（JSON） */
  data: string;
}

/** extract_cache 表的读写：按文件缓存跨文件识别之前的提取结果 */
export class ExtractCacheTable {
  constructor(private readonly db: DatabaseSync) {}

  /** 按 key 批量读取，命中的行同时更新 last_used_at；返回 key → data */
  lookup(keys: readonly string[], now = Date.now()): Map<string, string> {
    const out = new Map<string, string>();
    const select = this.db.prepare('SELECT key, data FROM extract_cache WHERE key IN (SELECT value FROM json_each(?))');
    const touch = this.db.prepare('UPDATE extract_cache SET last_used_at = ? WHERE key IN (SELECT value FROM json_each(?))');
    for (let i = 0; i < keys.length; i += LOOKUP_BATCH) {
      const batch = JSON.stringify(keys.slice(i, i + LOOKUP_BATCH));
      for (const r of select.all(batch) as Row[]) out.set(String(r.key), String(r.data));
    }
    const hits = [...out.keys()];
    if (hits.length > 0) {
      immediateTransaction(this.db, () => {
        for (let i = 0; i < hits.length; i += LOOKUP_BATCH) touch.run(now, JSON.stringify(hits.slice(i, i + LOOKUP_BATCH)));
      });
    }
    return out;
  }

  /** 写入新的缓存行；key 已存在时覆盖 */
  put(entries: readonly ExtractCacheEntry[], now = Date.now()): void {
    if (entries.length === 0) return;
    const st = this.db.prepare('INSERT OR REPLACE INTO extract_cache(key, path, data, last_used_at) VALUES (?, ?, ?, ?)');
    immediateTransaction(this.db, () => {
      for (const e of entries) st.run(e.key, e.path, e.data, now);
    });
  }

  /** 删除 last_used_at 早于 before 的行，返回删除的行数 */
  pruneBefore(before: number): number {
    return Number(this.db.prepare('DELETE FROM extract_cache WHERE last_used_at < ?').run(before).changes);
  }

  count(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM extract_cache').get() as Row).n);
  }
}
