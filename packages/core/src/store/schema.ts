/** 表结构或已入库数据的计算方式（如 body_hash）变化时加 1；版本不一致时直接删库重建，数据都可以从代码重新算出来 */
export const SCHEMA_VERSION = 2;

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
