import type { DatabaseSync } from 'node:sqlite';

/** 在 BEGIN IMMEDIATE 事务里执行：开始时就拿写锁，事务里先读后写不会因为别的连接抢先写入而失败 */
export function immediateTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
