import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { deflateSync, inflateSync } from 'node:zlib';
import type {
  EdgeKind,
  EdgeRow,
  EntryRow,
  FileRow,
  ReviewRow,
  ReviewStatus,
  SnapshotKind,
  SnapshotRow,
  StepStatus,
  SymbolRow,
} from '../model/types.js';
import { log } from '../log.js';
import { isProcessAlive } from './process.js';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

type Row = Record<string, SQLInputValue>;

const MAX_REVIEWS = 20;

function readSchemaVersion(db: DatabaseSync): number | undefined {
  const hasMeta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
  if (!hasMeta) return undefined;
  const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined;
  return row ? Number(row.value) : undefined;
}

function removeDbFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
}

function openRaw(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/** 打开库并读 schema 版本；文件不是合法的 SQLite 库时删掉重建 */
function openAndReadVersion(dbPath: string): { db: DatabaseSync; version: number | undefined } {
  let db: DatabaseSync | undefined;
  try {
    db = openRaw(dbPath);
    return { db, version: readSchemaVersion(db) };
  } catch (err) {
    if (db?.isOpen) db.close();
    if (!/not a database|malformed/i.test((err as Error).message)) throw err;
    log.warn('index_db_rebuild', { dbPath, reason: 'corrupt', error: (err as Error).message });
    removeDbFiles(dbPath);
    return { db: openRaw(dbPath), version: undefined };
  }
}

/**
 * 打开数据库；schema 版本不一致（或库是空的）时删库重建。
 * 返回值的 rebuilt 表示本次是否新建了库。
 */
export function openDatabase(dbPath: string): { db: DatabaseSync; rebuilt: boolean } {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const opened = openAndReadVersion(dbPath);
  let db = opened.db;
  const version = opened.version;
  if (version === SCHEMA_VERSION) return { db, rebuilt: false };
  if (version !== undefined) {
    log.info('index_db_rebuild', { dbPath, reason: 'schema_version_mismatch', found: version, expected: SCHEMA_VERSION });
    db.close();
    removeDbFiles(dbPath);
    db = openRaw(dbPath);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // 并发进程可能已经建好了
    if (readSchemaVersion(db) !== SCHEMA_VERSION) {
      db.exec(SCHEMA_SQL);
      db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { db, rebuilt: true };
}

export function encodeTokens(tokens: string[]): Uint8Array {
  return deflateSync(Buffer.from(tokens.join('\n'), 'utf8'));
}

export function decodeTokens(blob: Uint8Array | null): string[] {
  if (!blob || blob.length === 0) return [];
  const s = inflateSync(blob).toString('utf8');
  return s.length === 0 ? [] : s.split('\n');
}

function toSnapshot(r: Row): SnapshotRow {
  return {
    id: Number(r.id),
    kind: r.kind as SnapshotKind,
    commitSha: String(r.commit_sha),
    contentKey: String(r.content_key),
    extractStatus: r.extract_status as StepStatus,
    resolverStatus: r.resolver_status as StepStatus,
    resolverError: (r.resolver_error as string | null) ?? null,
    createdAt: Number(r.created_at),
    lastUsedAt: Number(r.last_used_at),
  };
}

function toFile(r: Row): FileRow {
  return {
    snapshotId: Number(r.snapshot_id),
    path: String(r.path),
    language: r.language as FileRow['language'],
    supportLevel: r.support_level as FileRow['supportLevel'],
    contentHash: String(r.content_hash),
    isTest: r.is_test === 1,
    isGenerated: r.is_generated === 1,
  };
}

export function toSymbol(r: Row, withTokens = true): SymbolRow {
  return {
    snapshotId: Number(r.snapshot_id),
    id: String(r.id),
    symbolKey: String(r.symbol_key),
    kind: String(r.kind),
    name: String(r.name),
    qualifiedName: String(r.qualified_name),
    signature: String(r.signature),
    displaySignature: String(r.display_signature),
    parentId: (r.parent_id as string | null) ?? null,
    path: String(r.path),
    startLine: Number(r.start_line),
    endLine: Number(r.end_line),
    bodyHash: String(r.body_hash),
    normTokens: withTokens ? decodeTokens(r.norm_tokens as Uint8Array | null) : [],
    docstring: (r.docstring as string | null) ?? null,
    isTest: r.is_test === 1,
    isGenerated: r.is_generated === 1,
  };
}

function toEdge(r: Row): EdgeRow {
  return {
    snapshotId: Number(r.snapshot_id),
    srcId: String(r.src_id),
    dstId: String(r.dst_id),
    kind: r.kind as EdgeRow['kind'],
    provenance: r.provenance as EdgeRow['provenance'],
    confidence: r.confidence as EdgeRow['confidence'],
    path: String(r.path),
    line: Number(r.line),
    col: Number(r.col),
  };
}

function toEntry(r: Row): EntryRow {
  return {
    snapshotId: Number(r.snapshot_id),
    symbolId: String(r.symbol_id),
    kind: r.kind as EntryRow['kind'],
    framework: String(r.framework),
    detail: JSON.parse(String(r.detail)) as Record<string, unknown>,
  };
}

function toReview(r: Row): ReviewRow {
  return {
    id: Number(r.id),
    params: JSON.parse(String(r.params)) as Record<string, unknown>,
    status: r.status as ReviewStatus,
    report: r.report == null ? null : JSON.parse(String(r.report)),
    error: (r.error as string | null) ?? null,
    progress: (r.progress as string | null) ?? null,
    createdAt: Number(r.created_at),
  };
}

export class Store {
  readonly db: DatabaseSync;
  readonly rebuilt: boolean;

  constructor(readonly dbPath: string) {
    const { db, rebuilt } = openDatabase(dbPath);
    this.db = db;
    this.rebuilt = rebuilt;
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- snapshots ----

  getSnapshotByKey(contentKey: string): SnapshotRow | undefined {
    const r = this.db.prepare('SELECT * FROM snapshots WHERE content_key = ?').get(contentKey) as Row | undefined;
    return r ? toSnapshot(r) : undefined;
  }

  getSnapshot(id: number): SnapshotRow | undefined {
    const r = this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as Row | undefined;
    return r ? toSnapshot(r) : undefined;
  }

  listSnapshots(): SnapshotRow[] {
    return (this.db.prepare('SELECT * FROM snapshots ORDER BY last_used_at DESC').all() as Row[]).map(toSnapshot);
  }

  createSnapshot(kind: SnapshotKind, commitSha: string, contentKey: string, now = Date.now()): SnapshotRow {
    this.db
      .prepare('INSERT INTO snapshots(kind, commit_sha, content_key, created_at, last_used_at) VALUES (?,?,?,?,?)')
      .run(kind, commitSha, contentKey, now, now);
    return this.getSnapshotByKey(contentKey)!;
  }

  setSnapshotStatus(id: number, patch: { extractStatus?: StepStatus; resolverStatus?: StepStatus; resolverError?: string | null }): void {
    if (patch.extractStatus) this.db.prepare('UPDATE snapshots SET extract_status = ? WHERE id = ?').run(patch.extractStatus, id);
    if (patch.resolverStatus) {
      this.db
        .prepare('UPDATE snapshots SET resolver_status = ?, resolver_error = ? WHERE id = ?')
        .run(patch.resolverStatus, patch.resolverError ?? null, id);
    }
  }

  touchSnapshot(id: number, now = Date.now()): void {
    this.db.prepare('UPDATE snapshots SET last_used_at = ? WHERE id = ?').run(now, id);
  }

  deleteSnapshot(id: number): void {
    this.db.prepare('DELETE FROM snapshots WHERE id = ?').run(id);
  }

  /** 清空某个快照的提取或解析结果，用于重新构建 */
  clearSnapshotData(id: number, what: 'extract' | 'edges'): void {
    if (what === 'extract') {
      for (const t of ['files', 'symbols', 'entries', 'edges']) {
        this.db.prepare(`DELETE FROM ${t} WHERE snapshot_id = ?`).run(id);
      }
    } else {
      this.db.prepare('DELETE FROM edges WHERE snapshot_id = ?').run(id);
    }
  }

  // ---- files / symbols / edges / entries ----

  insertFiles(rows: FileRow[]): void {
    const st = this.db.prepare(
      'INSERT INTO files(snapshot_id, path, language, support_level, content_hash, is_test, is_generated) VALUES (?,?,?,?,?,?,?)',
    );
    for (const f of rows) {
      st.run(f.snapshotId, f.path, f.language, f.supportLevel, f.contentHash, f.isTest ? 1 : 0, f.isGenerated ? 1 : 0);
    }
  }

  insertSymbols(rows: SymbolRow[]): void {
    const st = this.db.prepare(
      `INSERT INTO symbols(snapshot_id, id, symbol_key, kind, name, qualified_name, signature, display_signature,
        parent_id, path, start_line, end_line, body_hash, norm_tokens, docstring, is_test, is_generated)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const s of rows) {
      st.run(
        s.snapshotId, s.id, s.symbolKey, s.kind, s.name, s.qualifiedName, s.signature, s.displaySignature,
        s.parentId, s.path, s.startLine, s.endLine, s.bodyHash, encodeTokens(s.normTokens), s.docstring,
        s.isTest ? 1 : 0, s.isGenerated ? 1 : 0,
      );
    }
  }

  insertEdges(rows: EdgeRow[]): void {
    const st = this.db.prepare(
      'INSERT INTO edges(snapshot_id, src_id, dst_id, kind, provenance, confidence, path, line, col) VALUES (?,?,?,?,?,?,?,?,?)',
    );
    for (const e of rows) st.run(e.snapshotId, e.srcId, e.dstId, e.kind, e.provenance, e.confidence, e.path, e.line, e.col);
  }

  insertEntries(rows: EntryRow[]): void {
    const st = this.db.prepare('INSERT INTO entries(snapshot_id, symbol_id, kind, framework, detail) VALUES (?,?,?,?,?)');
    for (const e of rows) st.run(e.snapshotId, e.symbolId, e.kind, e.framework, JSON.stringify(e.detail));
  }

  getFiles(snapshotId: number): FileRow[] {
    return (this.db.prepare('SELECT * FROM files WHERE snapshot_id = ? ORDER BY path').all(snapshotId) as Row[]).map(toFile);
  }

  getSymbols(snapshotId: number, opts: { withTokens?: boolean } = {}): SymbolRow[] {
    const rows = this.db.prepare('SELECT * FROM symbols WHERE snapshot_id = ?').all(snapshotId) as Row[];
    return rows.map((r) => toSymbol(r, opts.withTokens ?? false));
  }

  getSymbol(snapshotId: number, id: string): SymbolRow | undefined {
    const r = this.db.prepare('SELECT * FROM symbols WHERE snapshot_id = ? AND id = ?').get(snapshotId, id) as Row | undefined;
    return r ? toSymbol(r) : undefined;
  }

  findSymbolsByName(snapshotId: number, name: string): SymbolRow[] {
    const rows = this.db.prepare('SELECT * FROM symbols WHERE snapshot_id = ? AND name = ?').all(snapshotId, name) as Row[];
    return rows.map((r) => toSymbol(r, false));
  }

  /** 按 id 批量取符号；id 列表作为一个 JSON 参数传入，不受 SQL 变量个数限制 */
  getSymbolsByIds(snapshotId: number, ids: string[], opts: { withTokens?: boolean } = {}): SymbolRow[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare('SELECT * FROM symbols WHERE snapshot_id = ? AND id IN (SELECT value FROM json_each(?))')
      .all(snapshotId, JSON.stringify(ids)) as Row[];
    return rows.map((r) => toSymbol(r, opts.withTokens ?? false));
  }

  /**
   * 批量取一组符号的边：direction 为 in 时取指向它们的边（按 dst_id），out 时取它们发出的边（按 src_id）。
   * kinds 不传时不按类型过滤。
   */
  getEdgesForSymbols(snapshotId: number, ids: string[], direction: 'in' | 'out', kinds?: EdgeKind[]): EdgeRow[] {
    if (ids.length === 0) return [];
    const column = direction === 'in' ? 'dst_id' : 'src_id';
    const kindFilter = kinds ? ' AND kind IN (SELECT value FROM json_each(?))' : '';
    const params: SQLInputValue[] = [snapshotId, JSON.stringify(ids), ...(kinds ? [JSON.stringify(kinds)] : [])];
    const rows = this.db
      .prepare(`SELECT * FROM edges WHERE snapshot_id = ? AND ${column} IN (SELECT value FROM json_each(?))${kindFilter}`)
      .all(...params) as Row[];
    return rows.map(toEdge);
  }

  getEdges(snapshotId: number): EdgeRow[] {
    return (this.db.prepare('SELECT * FROM edges WHERE snapshot_id = ?').all(snapshotId) as Row[]).map(toEdge);
  }

  /** 快照里各类数据的条数 */
  snapshotStats(snapshotId: number): { files: number; symbols: number; edges: number; entries: number } {
    const count = (table: string): number =>
      Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE snapshot_id = ?`).get(snapshotId) as Row).n);
    return { files: count('files'), symbols: count('symbols'), edges: count('edges'), entries: count('entries') };
  }

  getEntries(snapshotId: number): EntryRow[] {
    return (this.db.prepare('SELECT * FROM entries WHERE snapshot_id = ?').all(snapshotId) as Row[]).map(toEntry);
  }

  // ---- reviews ----

  createReview(params: Record<string, unknown>, now = Date.now()): number {
    const r = this.db
      .prepare("INSERT INTO reviews(params, status, pid, created_at) VALUES (?, 'running', ?, ?)")
      .run(JSON.stringify(params), process.pid, now);
    this.pruneReviews();
    return Number(r.lastInsertRowid);
  }

  setReviewProgress(id: number, progress: string): void {
    this.db.prepare('UPDATE reviews SET progress = ? WHERE id = ?').run(progress, id);
  }

  finishReview(id: number, report: unknown): void {
    this.db.prepare("UPDATE reviews SET status = 'done', report = ?, progress = NULL WHERE id = ?").run(JSON.stringify(report), id);
  }

  failReview(id: number, error: string): void {
    this.db.prepare("UPDATE reviews SET status = 'failed', error = ?, progress = NULL WHERE id = ?").run(error, id);
  }

  getReview(id: number): ReviewRow | undefined {
    const r = this.db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as Row | undefined;
    return r ? toReview(r) : undefined;
  }

  listReviews(limit = MAX_REVIEWS): ReviewRow[] {
    const rows = this.db
      .prepare('SELECT id, params, status, NULL AS report, error, progress, created_at FROM reviews ORDER BY id DESC LIMIT ?')
      .all(limit) as Row[];
    return rows.map(toReview);
  }

  /** 进程启动时调用：把执行进程已不存在的 running 任务改为 failed（其他进程正在跑的不动） */
  failInterruptedReviews(): number {
    const rows = this.db.prepare("SELECT id, pid FROM reviews WHERE status = 'running'").all() as Row[];
    let n = 0;
    for (const r of rows) {
      const pid = r.pid == null ? undefined : Number(r.pid);
      if (pid !== undefined && pid !== process.pid && isProcessAlive(pid)) continue;
      this.failReview(Number(r.id), 'interrupted: process exited before the review finished');
      n++;
    }
    return n;
  }

  pruneReviews(keep = MAX_REVIEWS): void {
    this.db.prepare('DELETE FROM reviews WHERE id NOT IN (SELECT id FROM reviews ORDER BY id DESC LIMIT ?)').run(keep);
  }
}
