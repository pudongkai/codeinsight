import path from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { log } from '../log.js';
import type { SnapshotKind } from '../model/types.js';
import type { OverviewReport } from '../overview/types.js';
import { isProcessAlive } from './process.js';
import { immediateTransaction } from './transaction.js';

type Row = Record<string, SQLInputValue>;

/** 只保留最近这么多条已结束的概览 */
export const MAX_OVERVIEWS = 10;

export type OverviewStatus = 'running' | 'done' | 'failed';

export interface OverviewParams {
  noLlm: boolean;
  sendSource: boolean;
  provider?: string;
  model?: string;
  /** sha256(provider + 请求地址 + 模型)，`--no-llm` 时按同一身份查缓存；不存请求地址原文 */
  llmIdentity?: string;
}

export interface OverviewProgress {
  step: string;
  done?: number;
  total?: number;
}

export interface OverviewRow {
  id: number;
  /** 用户给的 ref 原文；工作区为 `working` */
  ref: string;
  snapshotKind: SnapshotKind;
  commitSha: string;
  contentKey: string;
  params: OverviewParams;
  /** 结果里至少一个模块有 LLM 生成的名称或说明（本次请求或缓存命中） */
  hasLlm: boolean;
  status: OverviewStatus;
  progress: OverviewProgress | null;
  /** 只在 done 时有；列表查询不取 */
  result: OverviewReport | null;
  error: string | null;
  pid: number | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface NewOverview {
  ref: string;
  snapshotKind: SnapshotKind;
  commitSha: string;
  contentKey: string;
  params: OverviewParams;
}

export type BeginOverviewResult = { ok: true; id: number } | { ok: false; running: { id: number; pid: number } };

export interface CurrentOverview {
  overview?: OverviewRow;
  /** 选中的是带 AI 说明的记录、且之后又有只含结构部分的记录时，最新那条的 id */
  newerStructureId?: number;
}

const INTERRUPTED = 'interrupted: process exited before the overview finished';

/**
 * 本进程开始的、还没结束的任务（`<库文件绝对路径>#<id>`）。pid 会被复用（容器里每次都是 1），
 * 记录的 pid 等于本进程但不在这里的，是之前同 pid 的进程留下的，按已退出处理。
 */
const ownRunning = new Set<string>();

function parseJson<T>(v: SQLInputValue | undefined): T | null {
  return v == null ? null : (JSON.parse(String(v)) as T);
}

function toOverview(r: Row): OverviewRow {
  return {
    id: Number(r.id),
    ref: String(r.ref),
    snapshotKind: r.snapshot_kind as SnapshotKind,
    commitSha: String(r.commit_sha),
    contentKey: String(r.content_key),
    params: JSON.parse(String(r.params)) as OverviewParams,
    hasLlm: r.has_llm === 1,
    status: r.status as OverviewStatus,
    progress: parseJson<OverviewProgress>(r.progress),
    result: parseJson<OverviewReport>(r.result),
    error: (r.error as string | null) ?? null,
    pid: r.pid == null ? null : Number(r.pid),
    createdAt: Number(r.created_at),
    finishedAt: r.finished_at == null ? null : Number(r.finished_at),
  };
}

/** 列表查询不取 result（可能很大） */
const LIST_COLUMNS = 'id, ref, snapshot_kind, commit_sha, content_key, params, has_llm, status, progress, NULL AS result, error, pid, created_at, finished_at';

/** overviews 表的读写；CLI 和 serve 共用一个数据目录时靠这里保证同时只有一个生成任务 */
export class OverviewTable {
  private readonly dbKey: string;

  constructor(private readonly db: DatabaseSync, dbPath: string) {
    this.dbKey = path.resolve(dbPath);
  }

  private ownKey(id: number): string {
    return `${this.dbKey}#${id}`;
  }

  /** 记录的进程是否还在跑这个任务：本进程的只认自己开始的任务，其他进程看 pid 是否存活 */
  private isRunningAlive(id: number, pid: number | undefined): boolean {
    if (pid === undefined) return false;
    if (pid === process.pid) return ownRunning.has(this.ownKey(id));
    return isProcessAlive(pid);
  }

  /**
   * 开始一个生成任务：在 BEGIN IMMEDIATE 事务里把执行进程已不存在的 running 记录改为 failed，
   * 仍有存活的 running 记录时不新建并返回它（本进程自己开始的任务也算存活，由调用方决定是否复用），否则插入新的 running 记录。
   */
  begin(input: NewOverview, now = Date.now()): BeginOverviewResult {
    return immediateTransaction(this.db, () => {
      const running = this.failDeadRunning(now).alive;
      if (running) {
        log.info('overview_rejected', { reason: 'already_running', runningId: running.id, pid: running.pid });
        return { ok: false, running };
      }
      const r = this.db
        .prepare("INSERT INTO overviews(ref, snapshot_kind, commit_sha, content_key, params, status, pid, created_at) VALUES (?,?,?,?,?,'running',?,?)")
        .run(input.ref, input.snapshotKind, input.commitSha, input.contentKey, JSON.stringify(input.params), process.pid, now);
      const id = Number(r.lastInsertRowid);
      ownRunning.add(this.ownKey(id));
      log.info('overview_started', { id, ref: input.ref, snapshotKind: input.snapshotKind, noLlm: input.params.noLlm, sendSource: input.params.sendSource });
      return { ok: true, id };
    });
  }

  /**
   * 把执行进程已退出（含本进程 pid 但不是本进程开始的）的 running 记录改为 failed，返回改了几条。
   * serve 启动时调用：上次关闭时没跑完的任务不会一直显示为 running。
   */
  failInterrupted(now = Date.now()): number {
    return immediateTransaction(this.db, () => this.failDeadRunning(now).failed);
  }

  /** 把 pid 已不存在（或没有 pid）的 running 记录一次性改为 failed，返回改了几条和第一条仍存活的 running 记录 */
  private failDeadRunning(now: number): { alive?: { id: number; pid: number }; failed: number } {
    const rows = this.db.prepare("SELECT id, pid FROM overviews WHERE status = 'running' ORDER BY id").all() as Row[];
    const dead: number[] = [];
    let alive: { id: number; pid: number } | undefined;
    for (const r of rows) {
      const id = Number(r.id);
      const pid = r.pid == null ? undefined : Number(r.pid);
      if (pid !== undefined && this.isRunningAlive(id, pid)) alive ??= { id, pid };
      else dead.push(id);
    }
    if (dead.length > 0) {
      this.db
        .prepare("UPDATE overviews SET status = 'failed', error = ?, progress = NULL, finished_at = ? WHERE id IN (SELECT value FROM json_each(?))")
        .run(INTERRUPTED, now, JSON.stringify(dead));
      log.warn('overview_interrupted', { ids: dead.join(',') });
    }
    return { ...(alive ? { alive } : {}), failed: dead.length };
  }

  setProgress(id: number, progress: OverviewProgress): void {
    this.db.prepare('UPDATE overviews SET progress = ? WHERE id = ?').run(JSON.stringify(progress), id);
  }

  finish(id: number, result: OverviewReport, hasLlm: boolean, now = Date.now()): void {
    this.db
      .prepare("UPDATE overviews SET status = 'done', result = ?, has_llm = ?, progress = NULL, finished_at = ? WHERE id = ?")
      .run(JSON.stringify(result), hasLlm ? 1 : 0, now, id);
    ownRunning.delete(this.ownKey(id));
    log.info('overview_done', { id, hasLlm });
    this.prune();
  }

  fail(id: number, error: string, now = Date.now()): void {
    this.db.prepare("UPDATE overviews SET status = 'failed', error = ?, progress = NULL, finished_at = ? WHERE id = ?").run(error, now, id);
    ownRunning.delete(this.ownKey(id));
    log.warn('overview_failed', { id, error: error.split('\n')[0] });
    this.prune();
  }

  get(id: number): OverviewRow | undefined {
    const r = this.db.prepare('SELECT * FROM overviews WHERE id = ?').get(id) as Row | undefined;
    return r ? toOverview(r) : undefined;
  }

  /** 最近的记录，不含 result */
  list(limit = MAX_OVERVIEWS): OverviewRow[] {
    return (this.db.prepare(`SELECT ${LIST_COLUMNS} FROM overviews ORDER BY id DESC LIMIT ?`).all(limit) as Row[]).map(toOverview);
  }

  /**
   * Web、MCP 显示的当前概览：同类快照的 done 记录里，有带 AI 说明的就取其中最新的，否则取最新的一条；
   * 选中带 AI 说明的记录后又有只含结构部分的记录时，额外返回最新那条的 id。`--no-llm` 生成不会让 AI 说明消失。
   * withResult 为 false 时不取 result（只要 id、时间等字段时用）。
   */
  current(snapshotKind: SnapshotKind = 'working', opts: { withResult?: boolean } = {}): CurrentOverview {
    const columns = opts.withResult === false ? LIST_COLUMNS : '*';
    const latest = (hasLlm: 0 | 1 | null): Row | undefined => this.db
      .prepare(`SELECT ${columns} FROM overviews WHERE snapshot_kind = ? AND status = 'done' AND (? IS NULL OR has_llm = ?) ORDER BY finished_at DESC, id DESC LIMIT 1`)
      .get(snapshotKind, hasLlm, hasLlm) as Row | undefined;
    const named = latest(1);
    if (!named) {
      const any = latest(null);
      return any ? { overview: toOverview(any) } : {};
    }
    const overview = toOverview(named);
    const newer = this.db
      .prepare("SELECT id FROM overviews WHERE snapshot_kind = ? AND status = 'done' AND has_llm = 0 AND (finished_at > ? OR (finished_at = ? AND id > ?)) ORDER BY finished_at DESC, id DESC LIMIT 1")
      .get(snapshotKind, overview.finishedAt, overview.finishedAt, overview.id) as Row | undefined;
    return { overview, ...(newer ? { newerStructureId: Number(newer.id) } : {}) };
  }

  /** 上一次的名称（稳定命名用）：最近一条带 AI 说明的 done 记录，同类快照的优先 */
  lastNamed(snapshotKind: SnapshotKind): OverviewRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM overviews WHERE status = 'done' AND has_llm = 1 ORDER BY (snapshot_kind = ?) DESC, finished_at DESC, id DESC LIMIT 1")
      .get(snapshotKind) as Row | undefined;
    return r ? toOverview(r) : undefined;
  }

  /** 最近一条带 AI 说明的 done 记录的参数，不限快照类型（未配置 LLM 时的缓存身份）；不读报告正文 */
  lastNamedParams(): OverviewParams | undefined {
    const r = this.db
      .prepare("SELECT params FROM overviews WHERE status = 'done' AND has_llm = 1 ORDER BY finished_at DESC, id DESC LIMIT 1")
      .get() as Row | undefined;
    return r ? (JSON.parse(String(r.params)) as OverviewParams) : undefined;
  }

  /**
   * 只保留最近 keep 条已结束的记录，另外每种快照保留最新一条带 AI 说明的 done 记录：
   * 连续多次 `--no-llm` 或失败后，当前概览和上一次的名称仍然在。running 的不删，它结束时还要写回结果。
   */
  prune(keep = MAX_OVERVIEWS): void {
    this.db
      .prepare(`DELETE FROM overviews WHERE status <> 'running'
        AND id NOT IN (SELECT id FROM overviews WHERE status <> 'running' ORDER BY finished_at DESC, id DESC LIMIT ?)
        AND id NOT IN (SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY snapshot_kind ORDER BY finished_at DESC, id DESC) AS rn
          FROM overviews WHERE status = 'done' AND has_llm = 1) WHERE rn = 1)`)
      .run(keep);
  }
}
