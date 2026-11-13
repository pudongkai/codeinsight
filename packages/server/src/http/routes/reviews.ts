import type { ReviewParams } from '../../jobs/review-jobs.js';
import { repoOf, type Route, type RequestContext } from '../context.js';
import { HttpError, idParam, optBool, optString, readJsonBody, sendJson } from '../respond.js';

/** 入参同 CLI review：base、head、working、intent（意图文本）、noLlm */
function parseReviewParams(body: Record<string, unknown>): ReviewParams {
  const params: ReviewParams = {
    base: optString(body, 'base'), head: optString(body, 'head'), working: optBool(body, 'working'),
    intent: optString(body, 'intent'), noLlm: optBool(body, 'noLlm'),
  };
  if (params.head !== undefined && params.working) throw new HttpError(400, 'invalid_param', 'head and working cannot be used together');
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)) as ReviewParams;
}

async function createReview(ctx: RequestContext): Promise<void> {
  const params = parseReviewParams(await readJsonBody(ctx.req));
  const id = repoOf(ctx).reviewJobs.start(params);
  Object.assign(ctx.logFields, { reviewId: id, base: params.base, head: params.head, working: params.working });
  sendJson(ctx.res, 202, { id });
}

function getReview(ctx: RequestContext): void {
  const id = idParam(ctx.params.id, 'review id');
  ctx.logFields.reviewId = id;
  const r = repoOf(ctx).reviewJobs.get(id);
  if (!r) throw new HttpError(404, 'review_not_found');
  sendJson(ctx.res, 200, {
    id: r.id, status: r.status, progress: r.progress, params: r.params, createdAt: r.createdAt,
    ...(r.error !== null ? { error: r.error } : {}),
    ...(r.report !== null ? { report: r.report } : {}),
  });
}

export const reviewRoutes: Route[] = [
  { method: 'POST', pattern: '/api/reviews', handler: createReview },
  { method: 'GET', pattern: '/api/reviews/:id', handler: getReview },
];
