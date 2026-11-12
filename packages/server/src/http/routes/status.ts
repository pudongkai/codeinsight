import type { SnapshotRow } from '@codeinsight/core';
import { jobView } from '../../jobs/index-jobs.js';
import { overviewStale } from '../../jobs/overview-jobs.js';
import type { Route, RequestContext } from '../context.js';
import { sendJson } from '../respond.js';

/** 当前概览的摘要（不含报告正文） */
function overviewSummary(ctx: RequestContext, snap: SnapshotRow | undefined): { id: number; createdAt: number; stale: boolean } | null {
  const row = ctx.app.ws.store.overviews.current('working', { withResult: false }).overview;
  return row ? { id: row.id, createdAt: row.createdAt, stale: overviewStale(row, snap) } : null;
}

/** 仓库、Node 版本、LLM 配置和源码发送开关、索引进度和当前快照、最近的审查和当前概览（不含报告正文） */
function status(ctx: RequestContext): void {
  const { ws, indexJobs } = ctx.app;
  // 当前快照已被清理时这里会发起重建，下面的 latest 反映正在重建的任务
  const snap = indexJobs.current();
  const { latest, lastDone } = indexJobs.summary();
  sendJson(ctx.res, 200, {
    repo: ws.repo,
    node: process.version,
    llmConfigured: ws.config.llm !== undefined,
    llm: ws.config.llm ? { provider: ws.config.llm.provider, model: ws.config.llm.model } : null,
    sendSource: ws.config.overview.sendSource,
    index: { job: jobView(latest), lastDoneAt: lastDone?.finishedAt ?? null },
    snapshot: snap
      ? {
        id: snap.id, kind: snap.kind, commitSha: snap.commitSha, contentKey: snap.contentKey, createdAt: snap.createdAt,
        resolverStatus: snap.resolverStatus, resolverError: snap.resolverError,
      }
      : null,
    reviews: ws.store.listReviews().map(({ report: _r, ...rest }) => rest),
    overview: overviewSummary(ctx, snap),
  });
}

export const statusRoutes: Route[] = [{ method: 'GET', pattern: '/api/status', handler: status }];
