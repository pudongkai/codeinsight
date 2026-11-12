import { log, runReview } from '@codeinsight/core';
import type { ReviewOptions, ReviewRow } from '@codeinsight/core';
import type { ServerWorkspace } from '../workspace.js';
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
 * 启动时把执行进程已退出的 running 任务改为 failed。
 */
export class ReviewJobs {
  private readonly pending = new PendingSet();

  constructor(private readonly ws: ServerWorkspace) {
    const n = ws.store.failInterruptedReviews();
    if (n > 0) log.info('review_jobs_interrupted', { count: n });
  }

  start(params: ReviewParams): number {
    const id = this.ws.store.createReview({ ...params });
    log.info('review_job_start', { reviewId: id, base: params.base, head: params.head, working: params.working, intentChars: params.intent?.length, noLlm: params.noLlm });
    void this.pending.track(this.run(id, params));
    return id;
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
