import { estimateOverview, log, OverviewRunningError, startOverview } from '@codeinsight/core';
import type { OverviewEstimate, OverviewOptions, OverviewRow, OverviewStart, SnapshotRow } from '@codeinsight/core';
import type { ServerWorkspace } from '../workspace.js';
import { ClosedFlag } from './closed.js';
import { PendingSet } from './pending.js';

/** 估算和生成的入参（同 CLI overview 的 --no-llm、--no-source） */
export interface OverviewJobParams {
  noLlm?: boolean;
  noSource?: boolean;
}

export type OverviewStartResult =
  | { kind: 'started'; id: number }
  /** 本进程已有生成任务在跑，返回它的 id */
  | { kind: 'reused'; id: number }
  | { kind: 'needs_confirm'; estimate: OverviewEstimate };

/** 概览的 content_key 与当前快照不同；当前快照还没建好时无法判断，按未过期处理 */
export function overviewStale(row: Pick<OverviewRow, 'contentKey'>, snap: Pick<SnapshotRow, 'contentKey'> | undefined): boolean {
  return snap !== undefined && row.contentKey !== snap.contentKey;
}

/**
 * 当前工作区的概览生成任务：进度、结果和失败原因都写 overviews 表，serve 重启后仍能查到。
 * 同时只能有一个任务（CLI 和 serve 共用数据目录时也一样，由 overviews 表的 running 记录保证）；
 * 其他进程在跑时抛 OverviewRunningError。
 */
export class OverviewJobs {
  private readonly pending = new PendingSet();
  /** 本进程正在跑的任务 */
  private activeId: number | undefined;
  /** 上下文被替换后不再开始新任务 */
  readonly closed = new ClosedFlag();

  constructor(private readonly ws: ServerWorkspace) {}

  /**
   * 把执行进程已退出的 running 记录改为 failed。每个 serve 进程对同一个数据目录只调用一次
   * （由打开仓库的一方决定），切回同一仓库时不再调用。
   */
  recoverInterrupted(): void {
    const n = this.ws.store.overviews.failInterrupted();
    if (n > 0) log.info('overview_jobs_interrupted', { count: n });
  }

  /** 本进程正在跑的任务 id，没有时为 undefined */
  get runningId(): number | undefined {
    return this.activeId;
  }

  private options(snapshot: SnapshotRow, p: OverviewJobParams, id?: () => number | undefined): OverviewOptions {
    const { repo, store, layout, config } = this.ws;
    return {
      repo, store, layout, config, snapshot, ref: 'working', noLlm: p.noLlm, noSource: p.noSource,
      onLlmNotice: (message) => log.info('llm_notice', { overviewId: id?.(), message }),
    };
  }

  /** 估算请求数和 token，不发送、不写库、不写划分记录 */
  estimate(snapshot: SnapshotRow, p: OverviewJobParams): Promise<OverviewEstimate> {
    return estimateOverview(this.options(snapshot, p));
  }

  /**
   * 开始生成：本进程已有任务时直接返回它；没有 confirmed 时先估算，超过阈值返回 needs_confirm；
   * 其他进程在生成时抛 OverviewRunningError。已关闭时（包括估算期间被关闭）抛 RepoClosedError。
   */
  async start(snapshot: SnapshotRow, p: OverviewJobParams & { confirmed?: boolean }): Promise<OverviewStartResult> {
    if (this.activeId !== undefined) return this.reused(this.activeId);
    this.closed.check('overview');
    // 记录 id 在开始后才知道，生成时的提示日志通过它带上 id
    const started: { id?: number } = {};
    const opts = this.options(snapshot, p, () => started.id);
    let start: OverviewStart;
    try {
      start = await startOverview(opts, { confirmed: p.confirmed });
    } catch (err) {
      // 估算期间本进程的另一个请求已开始任务
      if (err instanceof OverviewRunningError && err.pid === process.pid) return this.reused(err.runningId);
      throw err;
    }
    if (start.kind === 'needs_confirm') return { kind: 'needs_confirm', estimate: start.estimate };
    if (this.closed.isClosed) {
      // 估算期间仓库已切换：记录已建好，标为失败，不在旧仓库生成
      this.ws.store.overviews.fail(start.id, 'cancelled: the repository was switched');
      log.info('overview_job_dropped', { overviewId: start.id, reason: 'repo_closed' });
      this.closed.check('overview');
    }
    const id = (started.id = start.id);
    log.info('overview_job_start', { overviewId: id, snapshotId: snapshot.id, noLlm: p.noLlm, noSource: p.noSource, confirmed: p.confirmed });
    this.launch(id, start.generate());
    return { kind: 'started', id };
  }

  get(id: number): OverviewRow | undefined {
    return this.ws.store.overviews.get(id);
  }

  /** 等正在跑的任务结束（关闭服务前用，避免关库后任务再写库） */
  drain(): Promise<void> {
    return this.pending.drain();
  }

  private reused(id: number): OverviewStartResult {
    log.info('overview_job_reused', { overviewId: id });
    return { kind: 'reused', id };
  }

  /** generateOverview 出错时已把记录改为 failed，这里只记日志 */
  private launch(id: number, job: Promise<unknown>): void {
    const started = Date.now();
    this.activeId = id;
    void this.pending.track(job.then(
      () => log.info('overview_job_done', { overviewId: id, ms: Date.now() - started }),
      (err: unknown) => log.warn('overview_job_failed', { overviewId: id, error: (err as Error).message.split('\n')[0], ms: Date.now() - started }),
    ).finally(() => {
      if (this.activeId === id) this.activeId = undefined;
    }));
  }
}
