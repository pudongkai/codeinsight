import { repoOf, type Route, type RequestContext } from '../context.js';
import { sendJson } from '../respond.js';
import { currentSnapshot, symbolInfo } from '../snapshot.js';

/** GET /api/entries?kind=&framework=：当前工作区快照的入口列表，按 kind、framework、位置排序 */
function entries(ctx: RequestContext): void {
  const q = ctx.url.searchParams;
  const kind = q.get('kind') || undefined;
  const framework = q.get('framework') || undefined;
  const snap = currentSnapshot(ctx);
  const store = repoOf(ctx).ws.store;
  const rows = store.getEntries(snap.id).filter((e) => (!kind || e.kind === kind) && (!framework || e.framework === framework));
  const symbols = new Map(store.getSymbolsByIds(snap.id, [...new Set(rows.map((e) => e.symbolId))]).map((s) => [s.id, s]));
  const items = rows
    .filter((e) => symbols.has(e.symbolId))
    .map((e) => ({ kind: e.kind, framework: e.framework, detail: e.detail, symbol: symbolInfo(symbols.get(e.symbolId)!, { kind: e.kind, framework: e.framework, detail: e.detail }) }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.framework.localeCompare(b.framework) || a.symbol.path.localeCompare(b.symbol.path) || a.symbol.startLine - b.symbol.startLine);
  ctx.logFields.results = items.length;
  sendJson(ctx.res, 200, { snapshotId: snap.id, entries: items });
}

export const entryRoutes: Route[] = [{ method: 'GET', pattern: '/api/entries', handler: entries }];
