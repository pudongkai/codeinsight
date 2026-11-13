import { buildSnapshot, log, SnapshotCancelledError } from '@codeinsight/core';
import type { SnapshotRow } from '@codeinsight/core';
import type { ServerWorkspace } from '../workspace.js';
import { ClosedFlag } from './closed.js';

export type JobStatus = 'running' | 'done' | 'failed';

export interface IndexJob {
  id: number;
  /** 谁发起的：startup / switch / api / mcp / snapshot_gone */
  reason: string;
  status: JobStatus;
  snapshotId?: number;
  /** 直接复用了已有快照 */
  cached?: boolean;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  /** 任务结束（成功或失败）时 resolve，不会 reject */
  done: Promise<IndexJob>;
}

/** 内存里只保留最近这么多个任务 */
const KEEP_JOBS = 20;

/**
 * 当前工作区的建索引任务（HTTP 的 POST /api/index、serve 启动、MCP 共用）。
 * 同一时间只跑一个：已有任务在跑时直接返回它。最近一次成功的快照作为"当前快照"，供搜索和入口列表使用。
 */
export class IndexJobs {
  private readonly jobs = new Map<number, IndexJob>();
  private nextId = 1;
  private running: IndexJob | undefined;
  /** 正在跑的任务的中止控制，cancel 时用 */
  private controller: AbortController | undefined;
  private lastDone: IndexJob | undefined;
  /** 上下文被替换后不再开始新任务 */
  readonly closed = new ClosedFlag();

  constructor(private readonly ws: ServerWorkspace) {}

  /** 已关闭时抛 RepoClosedError */
  start(reason: string): IndexJob {
    if (this.running) return this.running;
    this.closed.check('index');
    const job = { id: this.nextId++, reason, status: 'running', startedAt: Date.now() } as IndexJob;
    this.controller = new AbortController();
    job.done = this.run(job, this.controller.signal);
    this.running = job;
    this.jobs.set(job.id, job);
    for (const id of [...this.jobs.keys()].slice(0, Math.max(0, this.jobs.size - KEEP_JOBS))) this.jobs.delete(id);
    return job;
  }

  get(id: number): IndexJob | undefined {
    return this.jobs.get(id);
  }

  /**
   * 当前快照：最近一次成功建好（或复用）的快照。它已被清理（或库被重建）时自动发起重新建索引并返回 undefined，
   * 建好后自动成为新的当前快照。已关闭时不发起重建。
   */
  current(): SnapshotRow | undefined {
    const id = this.lastDone?.snapshotId;
    if (id === undefined) return undefined;
    const snap = this.ws.store.getSnapshot(id);
    if (snap && snap.extractStatus === 'ok') return snap;
    log.warn('current_snapshot_gone', { snapshotId: id });
    this.lastDone = undefined;
    if (!this.closed.isClosed) this.start('snapshot_gone');
    return undefined;
  }

  /**
   * 更新当前快照的 last_used_at。serve 运行期间定时调用，当前快照一直算"最近用过"，
   * 任何进程的快照清理都会跳过它（沿用"10 分钟内用过的不清理"规则，不需要跨进程额外协调）。
   */
  touchCurrent(): void {
    const snap = this.current();
    if (snap) this.ws.store.touchSnapshot(snap.id);
  }

  /** 最近一个任务（可能还在跑）和最近一次成功的任务，给 /api/status 用 */
  summary(): { latest?: IndexJob; lastDone?: IndexJob } {
    const latest = [...this.jobs.values()].at(-1);
    return { latest, lastDone: this.lastDone };
  }

  /** 正在跑的任务，没有时为 undefined */
  runningJob(): IndexJob | undefined {
    return this.running;
  }

  /**
   * 中止正在跑的任务并等它结束；任务记为 failed、error 为 `cancelled`。没有任务在跑时返回 false。
   * 中止在建快照的任何阶段都有效（检查点在文件之间，scip-python 运行中会被结束）。
   */
  async cancel(reason: string): Promise<boolean> {
    const job = this.running;
    if (!job) return false;
    log.info('index_job_cancel', { jobId: job.id, reason });
    this.controller?.abort(reason);
    await job.done;
    return true;
  }

  /** 等正在跑的任务结束（关闭服务前用，避免关库后任务再写库） */
  async drain(): Promise<void> {
    if (this.running) await this.running.done;
  }

  private async run(job: IndexJob, signal: AbortSignal): Promise<IndexJob> {
    const { repo, store, layout, config, resolver } = this.ws;
    log.info('index_job_start', { jobId: job.id, reason: job.reason });
    try {
      const result = await buildSnapshot({ repo, store, layout, config, resolver, signal });
      Object.assign(job, { status: 'done', snapshotId: result.snapshot.id, cached: result.cached, finishedAt: Date.now() });
      this.lastDone = job;
      log.info('index_job_done', { jobId: job.id, snapshotId: job.snapshotId, cached: job.cached, resolverStatus: result.snapshot.resolverStatus, ms: job.finishedAt! - job.startedAt });
    } catch (err) {
      const cancelled = err instanceof SnapshotCancelledError;
      Object.assign(job, { status: 'failed', error: cancelled ? 'cancelled' : (err as Error).message, finishedAt: Date.now() });
      if (cancelled) log.info('index_job_cancelled', { jobId: job.id, stage: err.stage });
      else log.warn('index_job_failed', { jobId: job.id, error: job.error });
    } finally {
      this.running = undefined;
      this.controller = undefined;
    }
    return job;
  }
}

/** 序列化给 HTTP 返回（去掉内部的 promise） */
export function jobView(job: IndexJob | undefined): Omit<IndexJob, 'done'> | null {
  if (!job) return null;
  const { id, reason, status, snapshotId, cached, error, startedAt, finishedAt } = job;
  return { id, reason, status, snapshotId, cached, error, startedAt, finishedAt };
}
