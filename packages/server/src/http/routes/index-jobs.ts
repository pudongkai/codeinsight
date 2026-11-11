import type { Route, RequestContext } from '../context.js';
import { sendJson } from '../respond.js';

/** 对当前工作区建索引（异步）；已有任务在跑时返回它的 id。进度从 GET /api/status 看 */
function startIndex(ctx: RequestContext): void {
  const job = ctx.app.indexJobs.start('api');
  ctx.logFields.jobId = job.id;
  sendJson(ctx.res, 202, { id: job.id, status: job.status });
}

export const indexRoutes: Route[] = [{ method: 'POST', pattern: '/api/index', handler: startIndex }];
