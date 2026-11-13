import { traverse } from '@codeinsight/core';
import type { SnapshotRow, SymbolRow, TraverseDirection } from '@codeinsight/core';
import { repoOf, type Route, type RequestContext } from '../context.js';
import { HttpError, intParam, sendJson } from '../respond.js';
import { currentSnapshot, entryMap, requireSnapshot, requireSymbol, symbolInfo, symbolInfos } from '../snapshot.js';

const MAX_TREE_DEPTH = 5;
const MAX_SEARCH_LIMIT = 200;

/** GET /api/symbols/search?q=&kind=&limit=：在当前工作区快照中按名字搜索 */
function search(ctx: RequestContext): void {
  const q = ctx.url.searchParams;
  const text = q.get('q')?.trim() ?? '';
  if (text === '') throw new HttpError(400, 'invalid_param', 'q is required');
  const limit = intParam(q.get('limit'), 'limit', { min: 1, max: MAX_SEARCH_LIMIT, fallback: 50 })!;
  const snap = currentSnapshot(ctx);
  const rows = repoOf(ctx).ws.store.searchSymbols(snap.id, text, { kind: q.get('kind') || undefined, limit });
  ctx.logFields.results = rows.length;
  sendJson(ctx.res, 200, { snapshotId: snap.id, results: symbolInfos(repoOf(ctx).ws.store, snap.id, rows) });
}

function target(ctx: RequestContext): { snap: SnapshotRow; sym: SymbolRow } {
  const snap = requireSnapshot(ctx, ctx.params.snapshot);
  return { snap, sym: requireSymbol(ctx, snap, ctx.params.id!) };
}

/** 直接调用方 / 被调用方（call + reference 边）的个数，按正式代码和测试代码分开 */
function neighborCounts(ctx: RequestContext, snap: SnapshotRow, sym: SymbolRow, direction: TraverseDirection) {
  const r = traverse(repoOf(ctx).ws.store, snap.id, [sym.id], { direction, depth: 1 });
  const ids = [...r.reached.get(sym.id)!.keys()];
  const test = ids.filter((id) => r.symbols.get(id)!.isTest).length;
  return { total: ids.length, prod: ids.length - test, test };
}

/** GET /api/symbols/:snapshot/:id：位置、签名、docstring、入口信息、调用方和被调用方数量 */
function detail(ctx: RequestContext): void {
  const { snap, sym } = target(ctx);
  const store = repoOf(ctx).ws.store;
  const parent = sym.parentId ? store.getSymbol(snap.id, sym.parentId) : undefined;
  const entries = store.getEntriesForSymbol(snap.id, sym.id).map((e) => ({ kind: e.kind, framework: e.framework, detail: e.detail }));
  sendJson(ctx.res, 200, {
    snapshotId: snap.id,
    resolverStatus: snap.resolverStatus,
    symbol: {
      ...symbolInfo(sym, entries.find((e) => e.kind === 'http') ?? entries[0]), docstring: sym.docstring,
      parent: parent ? symbolInfo(parent, entryMap(store, snap.id, [parent.id]).get(parent.id)) : null,
    },
    entries,
    callers: neighborCounts(ctx, snap, sym, 'callers'),
    callees: neighborCounts(ctx, snap, sym, 'callees'),
  });
}

/**
 * 调用方 / 被调用方树：nodes 是到达的符号及最短层数，edges 是走过的边（含调用点位置，同一对符号多处引用时有多条）。
 * `tests=false` 时不含测试代码。
 */
function tree(direction: TraverseDirection) {
  return (ctx: RequestContext): void => {
    const { snap, sym } = target(ctx);
    const q = ctx.url.searchParams;
    const depth = intParam(q.get('depth'), 'depth', { min: 1, max: MAX_TREE_DEPTH, fallback: 1 })!;
    const includeTests = q.get('tests') !== 'false' && q.get('tests') !== '0';
    const r = traverse(repoOf(ctx).ws.store, snap.id, [sym.id], { direction, depth, includeTests });
    const entries = entryMap(repoOf(ctx).ws.store, snap.id, [...r.symbols.keys()]);
    const info = (s: SymbolRow) => symbolInfo(s, entries.get(s.id));
    const nodes = [...r.reached.get(sym.id)!]
      .map(([id, d]) => ({ ...info(r.symbols.get(id)!), depth: d }))
      .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path) || a.startLine - b.startLine);
    const edges = r.edges.map((e) => ({ srcId: e.srcId, dstId: e.dstId, kind: e.kind, path: e.path, line: e.line, col: e.col }));
    ctx.logFields.nodes = nodes.length;
    sendJson(ctx.res, 200, { snapshotId: snap.id, resolverStatus: snap.resolverStatus, direction, depth, root: info(sym), nodes, edges });
  };
}

export const symbolRoutes: Route[] = [
  { method: 'GET', pattern: '/api/symbols/search', handler: search },
  { method: 'GET', pattern: '/api/symbols/:snapshot/:id', handler: detail },
  { method: 'GET', pattern: '/api/symbols/:snapshot/:id/callers', handler: tree('callers') },
  { method: 'GET', pattern: '/api/symbols/:snapshot/:id/callees', handler: tree('callees') },
];
