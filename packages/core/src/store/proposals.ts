import path from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { FilesProposal, PullRequestProposal } from '../ask/build-proposal.js';
import type { ProposalKind, ProposalResult, ProposalStatus, ProposalView } from '../ask/events.js';
import { isSensitivePath } from '../ask/sensitive.js';
import { log } from '../log.js';
import { isProcessAlive } from './process.js';

type Row = Record<string, SQLInputValue>;

/** 保存时没能重新生成修改的记录：payload 里只有路径等说明，没有可执行的内容 */
export interface UnbuiltMark {
  unbuilt?: true;
}

export type ProposalPayload = { kind: 'files'; payload: FilesProposal & UnbuiltMark } | { kind: 'pull_request'; payload: PullRequestProposal & UnbuiltMark };

export type ProposalRow = ProposalPayload & {
  id: number;
  sessionId: number;
  messageId: number;
  status: ProposalStatus;
  progress: Record<string, unknown> | null;
  result: ProposalResult | null;
  pid: number | null;
  createdAt: number;
  updatedAt: number;
};

/**
 * 新记录：保存回答时插入，只能是 pending 或（重新生成失败的）failed。
 * mergedFrom 为并入的同会话里还在等确认的记录，插入后这些记录改为 dismissed（不存进 payload）
 */
export type NewProposal = ProposalPayload & { status: 'pending' | 'failed'; result?: ProposalResult; mergedFrom?: number[] };

/** 并入的记录在保存前已被执行或忽略：新记录不能执行，要重新问 */
const MERGE_BASE_GONE = { code: 'merge_base_changed', message: 'a pending proposal this change builds on was applied or dismissed before the answer was saved; ask again' };

/** 执行中断（serve 退出）时记的原因 */
export const PROPOSAL_INTERRUPTED = '执行中断';
/**
 * applying 超过这么久没有更新，即使进程还在也认定执行中断（写文件只需几秒，卡住时允许用户重试）：
 * 启动时改为 failed，运行中也允许直接重新执行
 */
export const PROPOSAL_APPLYING_STALE_MS = 10 * 60_000;

/** 能开始执行的状态：pending、failed，或超时没有更新的 applying */
export function canStartApplying(row: Pick<ProposalRow, 'status' | 'updatedAt'>, now = Date.now()): boolean {
  return row.status === 'pending' || row.status === 'failed' || (row.status === 'applying' && now - row.updatedAt > PROPOSAL_APPLYING_STALE_MS);
}

const json = <T>(v: SQLInputValue | undefined): T | null => (v == null ? null : (JSON.parse(String(v)) as T));

function toRow(r: Row): ProposalRow {
  return {
    id: Number(r.id), sessionId: Number(r.session_id), messageId: Number(r.message_id),
    kind: r.kind as ProposalKind, payload: JSON.parse(String(r.payload)) as never,
    status: r.status as ProposalStatus, progress: json(r.progress), result: json(r.result),
    pid: r.pid == null ? null : Number(r.pid), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}

/** 卡片展示用：去掉文件内容和绝对路径 */
export function proposalView(row: ProposalRow): ProposalView {
  const base = {
    id: row.id, messageId: row.messageId, kind: row.kind, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt,
    ...(row.result ? { result: row.result } : {}), ...(row.payload.unbuilt ? { unbuilt: true } : {}),
    ...(row.status === 'applying' && canStartApplying(row) ? { retryable: true } : {}),
  };
  const files = (row.payload.files ?? []).map((f) => ({
    path: f.path, isNew: f.isNew, ...(f.staleSnapshot !== undefined ? { staleSnapshot: f.staleSnapshot } : {}), ...(f.sensitive ? { sensitive: true } : {}),
  }));
  if (row.kind === 'files') {
    const p = row.payload;
    return { ...base, summary: p.summary, root: p.root, ...(p.root !== 'repo' && p.rootPath ? { rootDir: path.basename(p.rootPath) } : {}), files };
  }
  const p = row.payload;
  const prFiles = p.changes
    ? p.changes.map((c) => ({ path: c.path, isNew: c.status === 'A', ...(c.status === 'D' ? { deleted: true } : {}), ...(isSensitivePath(c.path) ? { sensitive: true } : {}) }))
    : files;
  const pushed = row.progress?.pushed === true ? { pushed: true } : {};
  return { ...base, title: p.title, body: p.body, base: p.base, branch: p.branch, source: p.source, files: prFiles, ...(p.unpushedCommits?.length ? { unpushedCommits: p.unpushedCommits } : {}), ...pushed };
}

/** chat_proposals 表的读写 */
export class ProposalTable {
  constructor(private readonly db: DatabaseSync) {}

  /** 插入一条（调用方负责和回答放在同一个事务里） */
  insert(sessionId: number, messageId: number, p: NewProposal, now = Date.now()): number {
    const r = this.db
      .prepare('INSERT INTO chat_proposals(session_id, message_id, kind, payload, status, result, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sessionId, messageId, p.kind, JSON.stringify(p.payload), p.status, p.result ? JSON.stringify(p.result) : null, now, now);
    return Number(r.lastInsertRowid);
  }

  /**
   * 插入一条并处理合并（调用方负责放在保存回答的事务里）：mergedFrom 的记录都还是 pending 时改为 dismissed、
   * 结果记 mergedInto；有记录已被执行或忽略时新记录改为不能执行的 failed。返回新记录 id
   */
  insertMerging(sessionId: number, messageId: number, p: NewProposal, now = Date.now()): number {
    const from = p.mergedFrom ?? [];
    if (from.length === 0) return this.insert(sessionId, messageId, p, now);
    if (this.countPending(from) !== from.length) {
      log.warn('proposal_merge_base_gone', { mergedFrom: from.length });
      const payload = { ...p.payload, unbuilt: true as const };
      return this.insert(sessionId, messageId, { ...p, payload, status: 'failed', result: { error: MERGE_BASE_GONE } } as NewProposal, now);
    }
    const id = this.insert(sessionId, messageId, p, now);
    this.db
      .prepare("UPDATE chat_proposals SET status = 'dismissed', result = ?, pid = NULL, updated_at = ? WHERE status = 'pending' AND id IN (SELECT value FROM json_each(?))")
      .run(JSON.stringify({ mergedInto: id } satisfies ProposalResult), now, JSON.stringify(from));
    log.info('proposal_merged', { id, mergedFrom: from.length });
    return id;
  }

  private countPending(ids: readonly number[]): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM chat_proposals WHERE status = 'pending' AND id IN (SELECT value FROM json_each(?))")
      .get(JSON.stringify(ids)) as Row;
    return Number(r.n);
  }

  /** 会话里还在等确认、能执行的记录（不含保存时没能生成的），按 id 顺序 */
  pendingForSession(sessionId: number): ProposalRow[] {
    const rows = this.db
      .prepare("SELECT * FROM chat_proposals WHERE session_id = ? AND status = 'pending' AND COALESCE(json_extract(payload, '$.unbuilt'), 0) = 0 ORDER BY id")
      .all(sessionId) as Row[];
    return rows.map(toRow);
  }

  get(id: number): ProposalRow | undefined {
    const r = this.db.prepare('SELECT * FROM chat_proposals WHERE id = ?').get(id) as Row | undefined;
    return r ? toRow(r) : undefined;
  }

  /** 一组回答的全部修改，一次查询，按 id 顺序 */
  listByMessages(messageIds: number[]): ProposalRow[] {
    if (messageIds.length === 0) return [];
    const rows = this.db
      .prepare('SELECT * FROM chat_proposals WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY id')
      .all(JSON.stringify(messageIds)) as Row[];
    return rows.map(toRow);
  }

  /**
   * pending / failed（以及超过 PROPOSAL_APPLYING_STALE_MS 没有更新的 applying）能开始执行：改为 applying 并记下本进程号；
   * 状态已变时返回 false（同一条同时只执行一次）
   */
  startApplying(id: number, now = Date.now()): boolean {
    const r = this.db
      .prepare(`UPDATE chat_proposals SET status = 'applying', pid = ?, updated_at = ? WHERE id = ?
        AND (status IN ('pending', 'failed') OR (status = 'applying' AND updated_at < ?))
        AND COALESCE(json_extract(payload, '$.unbuilt'), 0) = 0`)
      .run(process.pid, now, id, now - PROPOSAL_APPLYING_STALE_MS);
    return Number(r.changes) > 0;
  }

  /** 执行没有开始写（如发现冲突）：从 applying 改回原来的状态，结果不变 */
  revertApplying(id: number, status: 'pending' | 'failed', now = Date.now()): void {
    this.db.prepare("UPDATE chat_proposals SET status = ?, pid = NULL, updated_at = ? WHERE id = ? AND status = 'applying'").run(status, now, id);
  }

  /** 执行结束：applied 或 failed，记结果 */
  finishApplying(id: number, status: 'applied' | 'failed', result: ProposalResult, now = Date.now()): void {
    this.db
      .prepare("UPDATE chat_proposals SET status = ?, result = ?, pid = NULL, updated_at = ? WHERE id = ? AND status = 'applying'")
      .run(status, JSON.stringify(result), now, id);
  }

  /** 执行中记下已完成的步骤（建 PR 的提交号、是否已推送），失败后重试从这里继续 */
  setProgress(id: number, progress: Record<string, unknown>, now = Date.now()): void {
    this.db.prepare('UPDATE chat_proposals SET progress = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(progress), now, id);
  }

  /** pending / failed（以及超过 PROPOSAL_APPLYING_STALE_MS 没有更新的 applying）→ dismissed；状态不允许时返回 false */
  dismiss(id: number, now = Date.now()): boolean {
    const r = this.db
      .prepare("UPDATE chat_proposals SET status = 'dismissed', pid = NULL, updated_at = ? WHERE id = ? AND (status IN ('pending', 'failed') OR (status = 'applying' AND updated_at < ?))")
      .run(now, id, now - PROPOSAL_APPLYING_STALE_MS);
    return Number(r.changes) > 0;
  }

  /**
   * 启动时调用：applying 记录的执行进程已不存在、或超过 PROPOSAL_APPLYING_STALE_MS 没有更新的，认定执行中断，改为 failed
   * （其他 serve 进程正在执行的不动）。返回改了几条
   */
  failInterrupted(now = Date.now()): number {
    const rows = this.db.prepare("SELECT id, pid, updated_at FROM chat_proposals WHERE status = 'applying'").all() as Row[];
    const ids = rows.filter((r) => {
      const pid = r.pid == null ? undefined : Number(r.pid);
      const alive = pid !== undefined && pid !== process.pid && isProcessAlive(pid);
      return !alive || now - Number(r.updated_at) > PROPOSAL_APPLYING_STALE_MS;
    }).map((r) => Number(r.id));
    if (ids.length === 0) return 0;
    const result = JSON.stringify({ error: { code: 'interrupted', message: PROPOSAL_INTERRUPTED } } satisfies ProposalResult);
    const n = Number(this.db
      .prepare("UPDATE chat_proposals SET status = 'failed', result = ?, pid = NULL, updated_at = ? WHERE status = 'applying' AND id IN (SELECT value FROM json_each(?))")
      .run(result, now, JSON.stringify(ids)).changes);
    log.info('proposals_interrupted', { count: n });
    return n;
  }
}
