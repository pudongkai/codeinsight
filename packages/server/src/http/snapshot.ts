import { log } from '@codeinsight/core';
import type { SnapshotRow, Store, SymbolRow } from '@codeinsight/core';
import type { AppContext, RequestContext } from './context.js';
import { HttpError, idParam } from './respond.js';

/** 浏览期间按这个间隔更新快照的 last_used_at，正在看的快照不会被当成久未使用而清理 */
const TOUCH_INTERVAL_MS = 60_000;

function touch(app: AppContext, snap: SnapshotRow): void {
  const now = Date.now();
  if (now - (app.touched.get(snap.id) ?? 0) < TOUCH_INTERVAL_MS) return;
  app.touched.set(snap.id, now);
  app.ws.store.touchSnapshot(snap.id, now);
}

function gone(ctx: RequestContext, snapshotId: number): HttpError {
  log.info('snapshot_gone', { snapshotId, path: ctx.url.pathname });
  return new HttpError(410, 'snapshot_gone');
}

/** 路径或查询参数里的快照：已被清理（或库重建）时返回 410 `snapshot_gone` */
export function requireSnapshot(ctx: RequestContext, raw: string | null | undefined): SnapshotRow {
  if (raw === null || raw === undefined || raw === '') throw new HttpError(400, 'invalid_param', 'snapshot is required');
  const id = idParam(raw, 'snapshot');
  ctx.logFields.snapshot = id;
  const snap = ctx.app.ws.store.getSnapshot(id);
  if (!snap || snap.extractStatus !== 'ok') throw gone(ctx, id);
  touch(ctx.app, snap);
  return snap;
}

/** 当前工作区快照（最近一次建好的索引）；还没建好或已被清理正在重建时返回 503 `index_not_ready` */
export function currentSnapshot(ctx: RequestContext): SnapshotRow {
  const snap = ctx.app.indexJobs.current();
  if (!snap) throw new HttpError(503, 'index_not_ready', 'the working tree index is being built');
  ctx.logFields.snapshot = snap.id;
  touch(ctx.app, snap);
  return snap;
}

export function requireSymbol(ctx: RequestContext, snap: SnapshotRow, id: string): SymbolRow {
  ctx.logFields.symbol = id;
  const sym = ctx.app.ws.store.getSymbol(snap.id, id);
  if (!sym) throw new HttpError(404, 'symbol_not_found');
  return sym;
}

export interface SymbolInfo {
  id: string;
  key: string;
  kind: string;
  name: string;
  qualifiedName: string;
  displaySignature: string;
  path: string;
  startLine: number;
  endLine: number;
  isTest: boolean;
  /** 数据模型类的类别（pydantic、sqlalchemy、django、dataclass 等），不是模型时不存在 */
  modelKind?: string;
  /** 入口信息（有多个时优先 HTTP 入口），不是入口时不存在；界面据此标出 HTTP 接口 */
  entry?: { kind: string; framework: string; detail: Record<string, unknown> };
}

type EntryInfo = NonNullable<SymbolInfo['entry']>;

export function symbolInfo(s: SymbolRow, entry?: EntryInfo): SymbolInfo {
  return {
    id: s.id, key: s.symbolKey, kind: s.kind, name: s.name, qualifiedName: s.qualifiedName, displaySignature: s.displaySignature,
    path: s.path, startLine: s.startLine, endLine: s.endLine, isTest: s.isTest,
    ...(s.modelKind ? { modelKind: s.modelKind } : {}),
    ...(entry ? { entry } : {}),
  };
}

/** 一组符号的入口：每个符号取一个，HTTP 入口优先 */
export function entryMap(store: Store, snapshotId: number, ids: string[]): Map<string, EntryInfo> {
  const out = new Map<string, EntryInfo>();
  for (const e of store.getEntriesForSymbols(snapshotId, ids)) {
    if (out.has(e.symbolId) && (out.get(e.symbolId)!.kind === 'http' || e.kind !== 'http')) continue;
    out.set(e.symbolId, { kind: e.kind, framework: e.framework, detail: e.detail });
  }
  return out;
}

/** 批量转换符号，带上各自的入口信息 */
export function symbolInfos(store: Store, snapshotId: number, rows: SymbolRow[]): SymbolInfo[] {
  const entries = entryMap(store, snapshotId, rows.map((r) => r.id));
  return rows.map((r) => symbolInfo(r, entries.get(r.id)));
}
