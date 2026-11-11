import { FUNCTION_KINDS, similarInSnapshot } from '@codeinsight/core';
import type { Route, RequestContext } from '../context.js';
import { HttpError, sendJson } from '../respond.js';
import { requireSnapshot, requireSymbol } from '../snapshot.js';

/** GET /api/similar?snapshot=&id=：单个函数的重复实现候选 */
function similar(ctx: RequestContext): void {
  const q = ctx.url.searchParams;
  const snap = requireSnapshot(ctx, q.get('snapshot'));
  const sym = requireSymbol(ctx, snap, q.get('id') ?? '');
  if (!FUNCTION_KINDS.has(sym.kind)) throw new HttpError(400, 'not_a_function');
  const minScore = ctx.app.ws.config.similarMinScore;
  const { findings } = similarInSnapshot(ctx.app.ws.store, snap.id, { queryIds: [sym.id], minScore });
  sendJson(ctx.res, 200, { snapshotId: snap.id, minScore, candidates: findings[0]?.candidates ?? [] });
}

export const similarRoutes: Route[] = [{ method: 'GET', pattern: '/api/similar', handler: similar }];
