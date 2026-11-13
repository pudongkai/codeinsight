/** 表结构或已入库数据的计算方式（如 body_hash）变化时加 1；版本不一致时直接删库重建，数据都可以从代码重新算出来 */
export const SCHEMA_VERSION = 3;

export const SCHEMA_SQL = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  content_key TEXT NOT NULL UNIQUE,
  extract_status TEXT NOT NULL DEFAULT 'pending',
  resolver_status TEXT NOT NULL DEFAULT 'pending',
  resolver_error TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

CREATE TABLE files (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  language TEXT NOT NULL,
  support_level TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  is_test INTEGER NOT NULL,
  is_generated INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, path)
);

CREATE TABLE symbols (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  symbol_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  signature TEXT NOT NULL,
  display_signature TEXT NOT NULL,
  parent_id TEXT,
  path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  body_hash TEXT NOT NULL,
  norm_tokens BLOB,
  docstring TEXT,
  is_test INTEGER NOT NULL,
  is_generated INTEGER NOT NULL,
  model_kind TEXT,
  PRIMARY KEY (snapshot_id, id)
);
CREATE INDEX symbols_name ON symbols(snapshot_id, name);
CREATE INDEX symbols_path ON symbols(snapshot_id, path);

CREATE TABLE edges (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  src_id TEXT NOT NULL,
  dst_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  provenance TEXT NOT NULL,
  confidence TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  col INTEGER NOT NULL
);
CREATE INDEX edges_src ON edges(snapshot_id, src_id);
CREATE INDEX edges_dst ON edges(snapshot_id, dst_id);

CREATE TABLE entries (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  symbol_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  framework TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX entries_symbol ON entries(snapshot_id, symbol_id);

CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  params TEXT NOT NULL,
  status TEXT NOT NULL,
  report TEXT,
  error TEXT,
  progress TEXT,
  pid INTEGER,
  created_at INTEGER NOT NULL
);
`;

/**
 * 不随 SCHEMA_VERSION 删库重建的表：每次打开库时缺哪张就建哪张（`IF NOT EXISTS`，并发重复执行无害），
 * 已有的快照和审查记录保留，旧版本打开带这些表的库时版本号一致，也不会删库。
 * 以后要加列时同样先检查列是否存在再 `ALTER TABLE ADD COLUMN`。
 */
export const EXTRA_TABLES = ['overviews', 'chat_sessions', 'chat_messages', 'extract_cache', 'snapshot_edges_code'] as const;

export const EXTRA_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS overviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL,
  snapshot_kind TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  content_key TEXT NOT NULL,
  params TEXT NOT NULL,
  has_llm INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  progress TEXT,
  result TEXT,
  error TEXT,
  pid INTEGER,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS overviews_kind_status ON overviews(snapshot_kind, status, finished_at);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_sessions_updated ON chat_sessions(updated_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  meta TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_session ON chat_messages(session_id, id);

-- 单个 Python 文件跨文件识别之前的提取结果（JSON），key 见 extract/cache.ts:extractCacheKey
CREATE TABLE IF NOT EXISTS extract_cache (
  key TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  data TEXT NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS extract_cache_used ON extract_cache(last_used_at);

-- 快照调用边是用哪个版本的提取和解析代码生成的，复用调用边前要求相同
CREATE TABLE IF NOT EXISTS snapshot_edges_code (
  snapshot_id INTEGER PRIMARY KEY REFERENCES snapshots(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL
);
`;
