import { log, runReview } from '@codeinsight/core';
import type { ReviewOptions, ReviewRow } from '@codeinsight/core';
import type { ServerWorkspace } from '../workspace.js';
import { ClosedFlag } from './closed.js';
import { PendingSet } from './pending.js';

/** POST /api/reviews 的入参（同 CLI review，去掉输出相关的选项） */
export interface ReviewParams {
  base?: string;
  head?: string;
  working?: boolean;
  intent?: string;
  noLlm?: boolean;
}

/**
 * 异步审查任务：参数、进度、报告和失败原因都写 reviews 表，serve 重启后仍能查到。
 */
export class ReviewJobs {
  private readonly pending = new PendingSet();
  /** 本进程正在跑的审查 */
  private readonly active = new Set<number>();
  /** 上下文被替换后不再开始新任务 */
  readonly closed = new ClosedFlag();

  constructor(private readonly ws: ServerWorkspace) {}

  /**
   * 把执行进程已退出的 running 任务改为 failed。pid 等于本进程的记录也会被改，
   * 所以每个 serve 进程对同一个数据目录只调用一次（由打开仓库的一方决定）。
   */
  recoverInterrupted(): void {
    const n = this.ws.store.failInterruptedReviews();
    if (n > 0) log.info('review_jobs_interrupted', { count: n });
  }

  /** 已关闭时抛 RepoClosedError */
  start(params: ReviewParams): number {
    this.closed.check('review');
    const id = this.ws.store.createReview({ ...params });
    log.info('review_job_start', { reviewId: id, base: params.base, head: params.head, working: params.working, intentChars: params.intent?.length, noLlm: params.noLlm });
    this.active.add(id);
    void this.pending.track(this.run(id, params).finally(() => this.active.delete(id)));
    return id;
  }

  /** 本进程正在跑的审查 id */
  activeIds(): number[] {
    return [...this.active];
  }

  get(id: number): ReviewRow | undefined {
    return this.ws.store.getReview(id);
  }

  /** 等正在跑的任务结束（关闭服务前用，避免关库后任务再写库） */
  drain(): Promise<void> {
    return this.pending.drain();
  }

  private async run(id: number, params: ReviewParams): Promise<void> {
    const { repo, store, layout, config, resolver } = this.ws;
    const started = Date.now();
    const opts: ReviewOptions = {
      repo, store, layout, config, resolver,
      base: params.base, head: params.head, working: params.working, noLlm: params.noLlm,
      intent: params.intent !== undefined ? { source: 'arg', text: params.intent } : undefined,
      onProgress: (step) => {
        store.setReviewProgress(id, step);
        log.info('review_job_progress', { reviewId: id, step });
      },
      onLlmNotice: (message) => log.info('llm_notice', { reviewId: id, message }),
    };
    try {
      const report = await runReview(opts);
      store.finishReview(id, report);
      log.info('review_job_done', { reviewId: id, ms: Date.now() - started });
    } catch (err) {
      store.failReview(id, (err as Error).message);
      log.warn('review_job_failed', { reviewId: id, error: (err as Error).message, ms: Date.now() - started });
    }
  }
}
