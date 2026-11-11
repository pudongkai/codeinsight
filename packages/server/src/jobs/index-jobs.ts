import { buildSnapshot, log } from '@codeinsight/core';
import type { SnapshotRow } from '@codeinsight/core';
import type { ServerWorkspace } from '../workspace.js';

export type JobStatus = 'running' | 'done' | 'failed';

export interface IndexJob {
  id: number;
  /** 谁发起的：startup / api / mcp */
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
  private lastDone: IndexJob | undefined;

  constructor(private readonly ws: ServerWorkspace) {}

  start(reason: string): IndexJob {
    if (this.running) return this.running;
    const job = { id: this.nextId++, reason, status: 'running', startedAt: Date.now() } as IndexJob;
    job.done = this.run(job);
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
   * 建好后自动成为新的当前快照。
   */
  current(): SnapshotRow | undefined {
    const id = this.lastDone?.snapshotId;
    if (id === undefined) return undefined;
    const snap = this.ws.store.getSnapshot(id);
    if (snap && snap.extractStatus === 'ok') return snap;
    log.warn('current_snapshot_gone', { snapshotId: id });
    this.lastDone = undefined;
    this.start('snapshot_gone');
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

  /** 等正在跑的任务结束（关闭服务前用，避免关库后任务再写库） */
  async drain(): Promise<void> {
    if (this.running) await this.running.done;
  }

  private async run(job: IndexJob): Promise<IndexJob> {
    const { repo, store, layout, config, resolver } = this.ws;
    log.info('index_job_start', { jobId: job.id, reason: job.reason });
    try {
      const result = await buildSnapshot({ repo, store, layout, config, resolver });
      Object.assign(job, { status: 'done', snapshotId: result.snapshot.id, cached: result.cached, finishedAt: Date.now() });
      this.lastDone = job;
      log.info('index_job_done', { jobId: job.id, snapshotId: job.snapshotId, cached: job.cached, resolverStatus: result.snapshot.resolverStatus, ms: job.finishedAt! - job.startedAt });
    } catch (err) {
      Object.assign(job, { status: 'failed', error: (err as Error).message, finishedAt: Date.now() });
      log.warn('index_job_failed', { jobId: job.id, error: job.error });
    } finally {
      this.running = undefined;
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
