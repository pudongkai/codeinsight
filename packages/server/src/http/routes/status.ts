import { jobView } from '../../jobs/index-jobs.js';
import type { Route, RequestContext } from '../context.js';
import { sendJson } from '../respond.js';

/** 仓库、Node 版本、LLM 是否配置、索引进度和当前快照、最近的审查（不含报告正文） */
function status(ctx: RequestContext): void {
  const { ws, indexJobs } = ctx.app;
  // 当前快照已被清理时这里会发起重建，下面的 latest 反映正在重建的任务
  const snap = indexJobs.current();
  const { latest, lastDone } = indexJobs.summary();
  sendJson(ctx.res, 200, {
    repo: ws.repo,
    node: process.version,
    llmConfigured: ws.config.llm !== undefined,
    index: { job: jobView(latest), lastDoneAt: lastDone?.finishedAt ?? null },
    snapshot: snap
      ? { id: snap.id, kind: snap.kind, commitSha: snap.commitSha, createdAt: snap.createdAt, resolverStatus: snap.resolverStatus, resolverError: snap.resolverError }
      : null,
    reviews: ws.store.listReviews().map(({ report: _r, ...rest }) => rest),
  });
}

export const statusRoutes: Route[] = [{ method: 'GET', pattern: '/api/status', handler: status }];
