import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { log, touchRecentRepo } from '@codeinsight/core';
import { ChangeDetector } from './changes.js';
import type { AppContext } from './http/context.js';
import { AskRuns } from './jobs/ask-runs.js';
import { IndexJobs } from './jobs/index-jobs.js';
import { OverviewJobs } from './jobs/overview-jobs.js';
import { ReviewJobs } from './jobs/review-jobs.js';
import { closeWorkspaceStore, type ServerWorkspace } from './workspace.js';

/** 一个打开的仓库：工作区和它的各种任务。切换仓库时整体替换 */
export interface RepoContext {
  /** 每打开一次仓库加 1，从 1 开始；网页用它判断仓库是否已切换 */
  gen: number;
  ws: ServerWorkspace;
  indexJobs: IndexJobs;
  reviewJobs: ReviewJobs;
  overviewJobs: OverviewJobs;
  askRuns: AskRuns;
  /** 快照 id → 上次更新 last_used_at 的时间，按快照节流写库 */
  touched: Map<number, number>;
  /** 正在处理、用到这个上下文的 HTTP 请求数；关闭 Store 前等它归零 */
  inflight: number;
  /** 已被替换、正在关闭 */
  closing: boolean;
  /** 工作区代码变化检测和自动更新索引 */
  changes: ChangeDetector;
}

export type RepoTaskKind = 'index' | 'overview' | 'review' | 'ask';

export interface RepoTask {
  kind: RepoTaskKind;
  id: number;
  /** 建索引和问答可以安全中止；概览和审查不能 */
  cancellable: boolean;
}

/** 关闭旧上下文时最多等进行中的请求这么久 */
export const INFLIGHT_WAIT_MS = 10_000;

/** 每个 serve 进程对同一个数据目录只做一次中断记录恢复，避免把本进程别的上下文正在跑的审查误标失败 */
function recoverOnce(app: AppContext, ctx: RepoContext): void {
  const key = path.resolve(ctx.ws.layout.root);
  if (app.recoveredDataDirs.has(key)) return;
  app.recoveredDataDirs.add(key);
  ctx.reviewJobs.recoverInterrupted();
  ctx.overviewJobs.recoverInterrupted();
}

/** 为打开的工作区建上下文：分配 gen、中断记录恢复、按设置在后台建索引 */
export function createRepoContext(app: AppContext, ws: ServerWorkspace, reason: 'startup' | 'switch'): RepoContext {
  const indexJobs = new IndexJobs(ws);
  const ctx: RepoContext = {
    gen: app.nextGen++, ws,
    indexJobs, reviewJobs: new ReviewJobs(ws), overviewJobs: new OverviewJobs(ws), askRuns: new AskRuns(),
    touched: new Map(), inflight: 0, closing: false,
    changes: new ChangeDetector({ ws, indexJobs, isClosing: () => ctx.closing }, app.changeCheckIntervalMs),
  };
  recoverOnce(app, ctx);
  if (app.indexOnOpen) ctx.indexJobs.start(reason);
  return ctx;
}

/** 把仓库放到最近列表最前；失败只记日志 */
export async function rememberRepo(repo: string): Promise<void> {
  try {
    await touchRecentRepo(repo);
  } catch (err) {
    log.warn('recent_repo_update_failed', { repo, error: (err as Error).message });
  }
}

/** 本进程在这个上下文里正在跑的任务 */
export function runningTasks(ctx: RepoContext): RepoTask[] {
  const tasks: RepoTask[] = [];
  const index = ctx.indexJobs.runningJob();
  if (index) tasks.push({ kind: 'index', id: index.id, cancellable: true });
  const overview = ctx.overviewJobs.runningId;
  if (overview !== undefined) tasks.push({ kind: 'overview', id: overview, cancellable: false });
  for (const id of ctx.reviewJobs.activeIds()) tasks.push({ kind: 'review', id, cancellable: false });
  for (const id of ctx.askRuns.activeSessions()) tasks.push({ kind: 'ask', id, cancellable: true });
  return tasks;
}

/** 中止建索引和问答并等它们结束（问答保存为 cancelled） */
export async function cancelTasks(ctx: RepoContext, reason: string): Promise<void> {
  await Promise.all([ctx.indexJobs.cancel(reason), ctx.askRuns.drain(reason)]);
}

/** 等进行中的请求结束；超时返回 false */
async function waitInflight(ctx: RepoContext, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (ctx.inflight > 0) {
    if (Date.now() >= deadline) return false;
    await sleep(20);
  }
  return true;
}

function drainJobs(ctx: RepoContext, reason: string): Promise<unknown> {
  return Promise.all([ctx.reviewJobs.drain(), ctx.indexJobs.drain(), ctx.overviewJobs.drain(), ctx.askRuns.drain(reason)]);
}

/**
 * 标记上下文已被替换：各任务类不再开始新任务（之后的开始请求得到 RepoClosedError），
 * 已进入路由、还在读请求体或估算的请求也不会在旧仓库里开始任务。
 */
export function markClosing(ctx: RepoContext): void {
  ctx.closing = true;
  for (const jobs of [ctx.indexJobs, ctx.reviewJobs, ctx.overviewJobs, ctx.askRuns]) jobs.closed.close();
}

/**
 * 关闭上下文并关闭它的 Store。drain 时先中止问答，等进行中的请求结束（最多 inflightTimeoutMs，超时记日志后照常关闭），
 * 再等请求期间可能新开始的任务结束，避免关库后还有人写库。
 */
export async function closeRepoContext(ctx: RepoContext, opts: { drain: boolean; reason: string; inflightTimeoutMs?: number }): Promise<void> {
  markClosing(ctx);
  const started = Date.now();
  if (opts.drain) {
    const asks = ctx.askRuns.drain(opts.reason);
    if (!(await waitInflight(ctx, opts.inflightTimeoutMs ?? INFLIGHT_WAIT_MS))) {
      log.warn('repo_context_close_timeout', { repo: ctx.ws.repo, gen: ctx.gen, inflight: ctx.inflight });
    }
    await asks;
    await drainJobs(ctx, opts.reason);
  }
  await ctx.changes.settled();
  closeWorkspaceStore(ctx.ws);
  log.info('repo_context_closed', { repo: ctx.ws.repo, gen: ctx.gen, waitedMs: Date.now() - started });
}
