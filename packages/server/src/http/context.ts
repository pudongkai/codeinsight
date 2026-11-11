import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IndexJobs } from '../jobs/index-jobs.js';
import type { ReviewJobs } from '../jobs/review-jobs.js';
import type { ServerWorkspace } from '../workspace.js';

/** 一个 serve 进程内各路由共用的状态 */
export interface AppContext {
  ws: ServerWorkspace;
  indexJobs: IndexJobs;
  reviewJobs: ReviewJobs;
  /** 静态文件目录（Web UI 构建产物）；不存在时首页显示占位页 */
  staticDir?: string;
  /** 快照 id → 上次更新 last_used_at 的时间，按快照节流写库 */
  touched: Map<number, number>;
}

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  app: AppContext;
  /** 请求日志里附带的关键参数，路由可以追加 */
  logFields: Record<string, unknown>;
}

export type Handler = (ctx: RequestContext) => Promise<void> | void;

export interface Route {
  method: 'GET' | 'POST';
  /** 如 `/api/symbols/:snapshot/:id/callers` */
  pattern: string;
  handler: Handler;
}
