import { excludeDirs, log, resolveRef, workingContentKey } from '@codeinsight/core';
import type { IndexJobs } from './jobs/index-jobs.js';
import type { ServerWorkspace } from './workspace.js';

/** 两次检测之间至少间隔这么久 */
export const CHANGE_CHECK_INTERVAL_MS = 10_000;

export interface ChangesView {
  /** 最近一次检测完成的时间；还没检测过为 null */
  checkedAt: number | null;
  /** 工作区内容键和当前快照不同 */
  codeChanged: boolean;
  autoReindex: boolean;
  /** 当前变化的代码自动更新索引失败过，不会再自动重试，要手动更新 */
  autoReindexFailed: boolean;
}

interface Target {
  ws: ServerWorkspace;
  indexJobs: IndexJobs;
  /** 上下文已被替换时不再检测 */
  isClosing(): boolean;
}

/**
 * 工作区代码变化检测（每个仓库上下文一个）：由 status 触发，后台算工作区内容键并和当前快照比较；
 * 打开自动更新时，连续两次得到同一个内容键（代码至少一个检测间隔没再变）就开始建索引，失败过的内容键不再自动重试。
 */
export class ChangeDetector {
  private startedAt = 0;
  private running: Promise<void> | undefined;
  private checkedAt: number | null = null;
  private codeChanged = false;
  /** 上一次检测得到的内容键，判断代码是否已停止变化 */
  private lastKey: string | undefined;
  private readonly failedKeys = new Set<string>();

  constructor(private readonly target: Target, private readonly intervalMs = CHANGE_CHECK_INTERVAL_MS) {}

  /** 上次检测到的内容键已和当前快照相同（如刚建好索引）时，不等下次检测就返回未变化 */
  view(autoReindex: boolean): ChangesView {
    const snap = this.codeChanged && !this.target.isClosing() ? this.target.indexJobs.current() : undefined;
    const caughtUp = snap !== undefined && snap.contentKey === this.lastKey;
    const codeChanged = this.codeChanged && !caughtUp;
    const autoReindexFailed = codeChanged && this.lastKey !== undefined && this.failedKeys.has(this.lastKey);
    return { checkedAt: this.checkedAt, codeChanged, autoReindex, autoReindexFailed };
  }

  /** 距离上次开始检测超过间隔且没有检测在进行时，在后台发起一次；不等它完成 */
  maybeCheck(autoReindex: boolean): void {
    const now = Date.now();
    if (this.running || now - this.startedAt < this.intervalMs || this.target.isClosing()) return;
    this.startedAt = now;
    this.running = this.check(autoReindex)
      .catch((err: unknown) => log.warn('change_check_failed', { repo: this.target.ws.repo, error: (err as Error).message }))
      .finally(() => (this.running = undefined));
  }

  /** 等进行中的检测结束（关闭上下文时用） */
  async settled(): Promise<void> {
    await this.running;
  }

  private async check(autoReindex: boolean): Promise<void> {
    const { ws, indexJobs } = this.target;
    const snap = indexJobs.runningJob() ? undefined : indexJobs.current();
    if (!snap) {
      // 当前快照还没建好或正在建索引：不比较
      this.record(false, undefined);
      return;
    }
    const started = Date.now();
    let key: string;
    try {
      const head = await resolveRef(ws.repo, 'HEAD');
      key = await workingContentKey(ws.repo, head, excludeDirs(ws.config, ws.repo));
    } catch (err) {
      log.warn('change_check_failed', { repo: ws.repo, error: (err as Error).message });
      return;
    }
    if (this.target.isClosing()) return;
    const changed = key !== snap.contentKey;
    const stable = key === this.lastKey;
    this.record(changed, key, Date.now() - started);
    if (changed && stable && autoReindex) this.autoStart(key);
  }

  private record(changed: boolean, key: string | undefined, ms?: number): void {
    if (changed !== this.codeChanged) log.info('change_check_result', { repo: this.target.ws.repo, codeChanged: changed, workingKey: key, ms });
    else log.debug('change_check_result', { codeChanged: changed, workingKey: key, ms });
    this.checkedAt = Date.now();
    this.codeChanged = changed;
    this.lastKey = key;
  }

  private autoStart(key: string): void {
    const { indexJobs } = this.target;
    if (indexJobs.runningJob() || this.failedKeys.has(key)) return;
    log.info('index_auto_start', { workingKey: key });
    const job = indexJobs.start('auto');
    void job.done.then((j) => {
      if (j.status === 'failed' && j.error !== 'cancelled') {
        this.failedKeys.add(key);
        log.warn('index_auto_failed', { workingKey: key, jobId: j.id });
      }
    });
  }
}
