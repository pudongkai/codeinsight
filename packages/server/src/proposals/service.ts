import { canStartApplying, GitError, knownFailure, log, proposalLogFields, proposalView } from '@codeinsight/core';
import type { ChatMessageInfo, FilesProposal, ProposalRow, ProposalView, Store } from '@codeinsight/core';
import { planFiles, resolveProposalRoot, toApplyError, writePlans, type FileConflict, type WriteEnv } from './apply-files.js';
import { filesDiff, pullRequestEditsDiff, pullRequestTreeDiff, type FileDiff } from './diff.js';
import { applyPullRequest, dropProposalRef } from './pull-request.js';

/** 不能执行或查看时的原因，路由转成 HTTP 状态码 */
export interface ProposalRejection {
  status: 404 | 409 | 500;
  code: string;
  message: string;
  files?: FileConflict[];
  proposal?: ProposalView;
}

export type ProposalOutcome<T> = { ok: true; value: T } | ({ ok: false } & ProposalRejection);

const reject = (status: ProposalRejection['status'], code: string, message: string, extra: Partial<ProposalRejection> = {}): { ok: false } & ProposalRejection => ({ ok: false, status, code, message, ...extra });

/** 会话详情：每条回答带上它的待确认修改（一次查询，按回答分组） */
export function withProposals(store: Store, messages: ChatMessageInfo[]): (ChatMessageInfo & { proposals?: ProposalView[] })[] {
  const ids = messages.filter((m) => m.role === 'assistant').map((m) => m.id);
  const byMessage = new Map<number, ProposalView[]>();
  for (const row of store.proposals.listByMessages(ids)) {
    const list = byMessage.get(row.messageId) ?? [];
    list.push(proposalView(row));
    byMessage.set(row.messageId, list);
  }
  return messages.map((m) => (m.role === 'assistant' ? { ...m, proposals: byMessage.get(m.id) ?? [] } : m));
}

/** 记录存在、保存时生成成功 */
function loadExecutable(store: Store, id: number): ProposalOutcome<ProposalRow> {
  const row = store.proposals.get(id);
  if (!row) return reject(404, 'proposal_not_found', 'no such proposal');
  if (row.payload.unbuilt) return reject(409, 'not_applicable', 'the change could not be prepared when the answer was saved; ask again', { proposal: proposalView(row) });
  return { ok: true, value: row };
}

function statusRejection(row: ProposalRow): { ok: false } & ProposalRejection {
  const proposal = proposalView(row);
  if (row.status === 'applying') return reject(409, 'proposal_applying', 'the proposal is being applied', { proposal });
  return reject(409, 'invalid_status', `a proposal in status ${row.status} cannot be applied`, { proposal });
}

function logApply(row: ProposalRow, fields: Record<string, unknown>): void {
  const { id, kind, root, rootDir, files } = proposalLogFields(row) as Record<string, unknown>;
  log.info('proposal_apply', { id, kind, root, rootDir, files, ...fields });
}

/** 写文件：检查根目录和路径、算出写法；有冲突时改回原状态返回 409，否则按顺序写，记 applied 或 failed */
async function applyFiles(store: Store, row: ProposalRow & { kind: 'files' }, prev: 'pending' | 'failed', env: WriteEnv, force: boolean): Promise<ProposalOutcome<ProposalView>> {
  const p: FilesProposal = row.payload;
  const id = row.id;
  try {
    const root = await resolveProposalRoot(p, env);
    const { plans, conflicts } = await planFiles(root, p.files, force);
    if (conflicts.length > 0) {
      store.proposals.revertApplying(id, prev);
      logApply(row, { result: 'conflict', code: conflicts[0]!.code, conflicts: conflicts.length, force });
      const view = proposalView(store.proposals.get(id)!);
      return reject(409, conflicts[0]!.code, 'files changed since the proposal was made', { files: conflicts, proposal: view });
    }
    const { written, error } = await writePlans(root.scope, plans);
    store.proposals.finishApplying(id, error ? 'failed' : 'applied', { written, ...(error ? { error: { code: error.code, message: error.message } } : {}) });
    logApply(row, { result: error ? 'failed' : 'applied', code: error?.code, written: written.length, force });
    const view = proposalView(store.proposals.get(id)!);
    return error?.code === 'file_exists' ? reject(409, 'file_exists', error.message, { proposal: view }) : { ok: true, value: view };
  } catch (err) {
    const e = toApplyError(err);
    store.proposals.finishApplying(id, 'failed', { written: [], error: { code: e.code, message: e.message } });
    logApply(row, { result: 'failed', code: e.code, written: 0, force });
    return { ok: true, value: proposalView(store.proposals.get(id)!) };
  }
}

/** 执行：只接受 pending、failed 和超时没有更新的 applying，先改为 applying（同一条同时只执行一次） */
export async function applyProposal(store: Store, id: number, env: WriteEnv, force: boolean): Promise<ProposalOutcome<ProposalView>> {
  const loaded = loadExecutable(store, id);
  if (!loaded.ok) return loaded;
  const row = loaded.value;
  if (!canStartApplying(row)) return statusRejection(row);
  if (!store.proposals.startApplying(id)) return statusRejection(store.proposals.get(id) ?? row);
  if (row.kind === 'pull_request') return { ok: true, value: await applyPullRequest(store, row, env) };
  // 超时重新执行的 applying 发现冲突时改回 failed
  return applyFiles(store, row, row.status === 'pending' ? 'pending' : 'failed', env, force);
}

/** pending / failed → dismissed；working_tree 来源的 PR 同时删除保存 tree 的引用 */
export async function dismissProposal(store: Store, id: number, env: WriteEnv): Promise<ProposalOutcome<ProposalView>> {
  const row = store.proposals.get(id);
  if (!row) return reject(404, 'proposal_not_found', 'no such proposal');
  if (!store.proposals.dismiss(id)) return reject(409, 'invalid_status', `a proposal in status ${row.status} cannot be dismissed`, { proposal: proposalView(row) });
  log.info('proposal_dismissed', proposalLogFields(store.proposals.get(id)!));
  await dropProposalRef(env, row);
  return { ok: true, value: proposalView(store.proposals.get(id)!) };
}

/** 删除会话前：删掉会话里 working_tree 来源的 PR 保存 tree 用的引用（记录随会话一起删除） */
export async function dropSessionProposalRefs(store: Store, sessionId: number, env: WriteEnv): Promise<number> {
  const ids = store.chats.messages(sessionId).filter((m) => m.role === 'assistant').map((m) => m.id);
  const rows = store.proposals.listByMessages(ids).filter((r) => r.kind === 'pull_request' && r.payload.source === 'working_tree');
  for (const r of rows) await dropProposalRef(env, r);
  return rows.length;
}

function diffOf(row: ProposalRow, env: WriteEnv): Promise<FileDiff[]> {
  if (row.kind === 'files') return filesDiff(row.payload, env);
  return row.payload.source === 'working_tree' ? pullRequestTreeDiff(env.repo, row.payload) : pullRequestEditsDiff(env.repo, row.payload);
}

/** 每个文件的统一 diff；写文件类带 changedSinceProposal */
export async function proposalDiff(store: Store, id: number, env: WriteEnv): Promise<ProposalOutcome<FileDiff[]>> {
  const loaded = loadExecutable(store, id);
  if (!loaded.ok) return loaded;
  const row = loaded.value;
  try {
    return { ok: true, value: await diffOf(row, env) };
  } catch (err) {
    return diffFailure(row, err);
  }
}

/** 根目录或路径不再允许时按原因返回 409；其他错误（git 失败、读文件失败）为 diff_failed */
function diffFailure(row: ProposalRow, err: unknown): { ok: false } & ProposalRejection {
  const known = err instanceof GitError ? undefined : knownFailure(err);
  if (known) return reject(409, known.code, known.message);
  log.warn('proposal_diff_failed', { id: row.id, kind: row.kind, error: (err as Error).message.split('\n')[0] });
  return reject(500, 'diff_failed', 'the diff could not be generated');
}
