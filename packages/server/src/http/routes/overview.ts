import { OverviewRunningError, workingKeyHasChanges } from '@codeinsight/core';
import type { OverviewRow } from '@codeinsight/core';
import { overviewStale, type OverviewJobParams, type OverviewStartResult } from '../../jobs/overview-jobs.js';
import { repoOf, type Route, type RequestContext } from '../context.js';
import { boolParam, HttpError, idParam, optBool, readJsonBody, sendJson } from '../respond.js';
import { currentSnapshot } from '../snapshot.js';

/** 带 id 时取那条已完成的记录，否则取当前概览（见 OverviewTable.current） */
function pickOverview(ctx: RequestContext): { row?: OverviewRow; newerStructureId?: number } {
  const { store } = repoOf(ctx).ws;
  const raw = ctx.url.searchParams.get('id');
  if (raw === null || raw === '') {
    const c = store.overviews.current('working');
    return { row: c.overview, newerStructureId: c.newerStructureId };
  }
  const row = store.overviews.get(idParam(raw, 'id'));
  return { row: row?.status === 'done' ? row : undefined };
}

/**
 * GET /api/overview?id=：`{id, overview, stale, currentContentKey, snapshotDirty, newerStructureId?}`，没有时 404。
 * snapshotDirty：概览所基于的代码含未提交改动。
 */
function getOverview(ctx: RequestContext): void {
  const { row, newerStructureId } = pickOverview(ctx);
  if (!row?.result) throw new HttpError(404, 'overview_not_found');
  ctx.logFields.overviewId = row.id;
  const snap = repoOf(ctx).indexJobs.current();
  sendJson(ctx.res, 200, {
    id: row.id, overview: row.result, stale: overviewStale(row, snap), currentContentKey: snap?.contentKey ?? null,
    snapshotDirty: row.result.snapshot.kind === 'working' && workingKeyHasChanges(row.result.snapshot.contentKey),
    ...(newerStructureId !== undefined ? { newerStructureId } : {}),
  });
}

/** GET /api/overview/estimate?noLlm=&noSource=：对当前快照估算，不发送请求 */
async function estimate(ctx: RequestContext): Promise<void> {
  const q = ctx.url.searchParams;
  const p: OverviewJobParams = { noLlm: boolParam(q.get('noLlm'), 'noLlm'), noSource: boolParam(q.get('noSource'), 'noSource') };
  const snap = currentSnapshot(ctx);
  sendJson(ctx.res, 200, await repoOf(ctx).overviewJobs.estimate(snap, p));
}

async function startJob(ctx: RequestContext, p: OverviewJobParams & { confirmed?: boolean }): Promise<OverviewStartResult> {
  const snap = currentSnapshot(ctx);
  try {
    return await repoOf(ctx).overviewJobs.start(snap, p);
  } catch (err) {
    if (err instanceof OverviewRunningError) throw new HttpError(409, 'overview_running', err.message, { pid: err.pid });
    throw err;
  }
}

/** POST /api/overview `{noLlm?, noSource?, confirmed?}`：异步生成，202 `{id}`；超过阈值未确认、其他进程在生成时 409 */
async function createOverview(ctx: RequestContext): Promise<void> {
  const body = await readJsonBody(ctx.req);
  const p = { noLlm: optBool(body, 'noLlm'), noSource: optBool(body, 'noSource'), confirmed: optBool(body, 'confirmed') };
  Object.assign(ctx.logFields, p);
  const r = await startJob(ctx, p);
  if (r.kind === 'needs_confirm') {
    throw new HttpError(409, 'needs_confirm', 'estimated input tokens exceed overview.confirmTokens; send confirmed: true to generate', { estimate: r.estimate });
  }
  ctx.logFields.overviewId = r.id;
  sendJson(ctx.res, 202, { id: r.id, ...(r.kind === 'reused' ? { reused: true } : {}) });
}

/** GET /api/overview/jobs/:id：`{id, status, progress, error?, createdAt, finishedAt}` */
function getJob(ctx: RequestContext): void {
  const id = idParam(ctx.params.id, 'overview id');
  ctx.logFields.overviewId = id;
  const r = repoOf(ctx).overviewJobs.get(id);
  if (!r) throw new HttpError(404, 'overview_not_found');
  sendJson(ctx.res, 200, {
    id, status: r.status, progress: r.progress, createdAt: r.createdAt, finishedAt: r.finishedAt,
    ...(r.error !== null ? { error: r.error } : {}),
  });
}

export const overviewRoutes: Route[] = [
  { method: 'GET', pattern: '/api/overview', handler: getOverview },
  { method: 'POST', pattern: '/api/overview', handler: createOverview },
  { method: 'GET', pattern: '/api/overview/estimate', handler: estimate },
  { method: 'GET', pattern: '/api/overview/jobs/:id', handler: getJob },
];
