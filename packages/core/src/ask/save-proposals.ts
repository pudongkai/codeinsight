import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dataDirInRepo } from '../config/index.js';
import { commitSubjects, GitError, repoRoot } from '../git/index.js';
import { collectWorkingTree, fetchOriginBranch, gitRun, originDefaultBranch, updateRef } from '../git/write.js';
import { log } from '../log.js';
import type { NewProposal, ProposalRow } from '../store/proposals.js';
import { ProposalError } from '../util/failure.js';
import { buildFilesProposal, buildPullRequestProposal, requestedBase, type ProposedFile, type PullRequestProposal } from './build-proposal.js';
import { PROPOSE_FILE_CHANGES, type ProposalResult } from './events.js';
import { knownFailure } from './proposal-failure.js';
import { ProposalDrafts, type MergeInfo } from './proposal-drafts.js';
import type { AskToolContext } from './tool-context.js';

/** 一次写工具调用：原始参数（含文件内容，只在内存里） */
export interface PendingWrite {
  name: string;
  args: Record<string, unknown>;
  /** 工具返回成功（tool_done 没有 error） */
  ok: boolean;
  /** 调用时间：保存时按它取默认分支名，和工具当时告诉模型的一致 */
  at: number;
  /** 工具执行时的实际顺序（结果里的 change #N）；本机 CLI 并行调用时和开始的顺序可能不同，保存时按它重新生成 */
  seq?: number;
}

/** 失败原因不含绝对路径：git 失败只取超时、取消或错误输出首行 */
function failureResult(err: unknown): ProposalResult {
  const known = knownFailure(err, 'preparing the change');
  if (known) return { error: known };
  log.error('proposal_rebuild_error', { error: (err as Error).message.split('\n')[0] });
  return { error: { code: 'internal_error', message: 'internal error while preparing the change' } };
}

/** 参数里的文件路径（不含内容），重新生成失败时卡片据此列出文件 */
function argFiles(args: Record<string, unknown>): ProposedFile[] {
  const files = Array.isArray(args.files) ? (args.files as unknown[]) : [];
  return files.flatMap((f) => {
    const o = (f ?? {}) as Record<string, unknown>;
    return typeof o.path === 'string' ? [{ path: o.path, isNew: o.create !== undefined && o.create !== null, content: '', baseSha1: null }] : [];
  });
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 重新生成失败的记录：payload 只有说明和路径，标为 unbuilt，不能执行 */
function unbuilt(w: PendingWrite, err: unknown): NewProposal {
  const result = failureResult(err);
  const files = argFiles(w.args);
  if (w.name === PROPOSE_FILE_CHANGES) {
    return { kind: 'files', status: 'failed', result, payload: { root: str(w.args.root) || 'repo', rootPath: '', summary: str(w.args.summary), files, unbuilt: true } };
  }
  const source = w.args.fromWorkingTree ? 'working_tree' : 'edits';
  const payload = { title: str(w.args.title), body: '', base: str(w.args.base), branch: str(w.args.branch), source, startCommit: '', files, unbuilt: true } as const;
  return { kind: 'pull_request', status: 'failed', result, payload };
}

/** 保存过程中的状态：取消信号；同一个目标分支只 fetch 一次，远程默认分支只查一次 */
interface RebuildState {
  signal?: AbortSignal;
  fetched: Map<string, Promise<void>>;
  defaultBase?: Promise<string | undefined>;
}

/**
 * working_tree 来源保存的 tree 由这个引用指着，防止被 git gc 清理；执行完、忽略或删除会话后删除。
 * 多个 worktree 共用 refs，各自的数据目录里 id 会重复，所以按数据目录分开
 */
export function proposalRef(dataDir: string, id: number): string {
  const dir = createHash('sha1').update(path.resolve(dataDir)).digest('hex').slice(0, 12);
  return `refs/codeinsight/proposals/${dir}/${id}`;
}

/** 重新生成的一条，以及它在叠加时并掉了哪些前面的组 */
interface Rebuilt {
  proposal: NewProposal;
  merge?: MergeInfo;
}

async function rebuildFiles(ctx: AskToolContext, w: PendingWrite): Promise<Rebuilt> {
  const { proposal, merge } = await buildFilesProposal(ctx, w.args);
  return { proposal: { kind: 'files', status: 'pending', payload: proposal }, merge };
}

/** 目标分支：和工具执行时同一取法，取不到本地记录时可以联网问 origin 和 gh */
function saveTimeBase(ctx: AskToolContext, w: PendingWrite, st: RebuildState): Promise<string> {
  const online = { ...(st.signal ? { signal: st.signal } : {}) };
  return requestedBase(ctx.repo, w.args, () => (st.defaultBase ??= originDefaultBranch(ctx.repo, { online })));
}

/** 在临时索引里（以用户索引为起点）加上工作区的改动，生成 tree，算出改动文件和未推送的提交。不碰仓库的索引和工作区 */
async function snapshotWorkingTree(ctx: AskToolContext, p: PullRequestProposal, signal?: AbortSignal): Promise<Pick<PullRequestProposal, 'tree' | 'changes' | 'unpushedCommits'>> {
  const root = await repoRoot(ctx.repo);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codeinsight-index-'));
  try {
    const run = await gitRun(root, signal);
    const excluded = dataDirInRepo({ repo: root, dataDir: ctx.layout.root });
    const collected = await collectWorkingTree(run, path.join(dir, 'index'), p.startCommit, p.paths ?? [], excluded);
    const tree = collected.tree;
    const changes = collected.changes.map((c) => ({ path: c.path, status: c.status }));
    if (changes.length === 0) throw new ProposalError('no_changes', 'there are no uncommitted changes to put into the pull request');
    const unpushedCommits = await commitSubjects(root, `refs/remotes/origin/${p.base}..${p.startCommit}`);
    log.info('proposal_tree_built', { base: p.base, branch: p.branch, files: changes.length, unpushed: unpushedCommits.length });
    return { tree, changes, unpushedCommits };
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
    const known = knownFailure(err, 'collecting the uncommitted changes')!;
    throw new ProposalError(known.code, known.message);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * PR：先 fetch 目标分支。edits 来源按最新的 origin/<base> 生成修改；
 * working_tree 来源以 HEAD 为起点用临时索引生成 tree（保存后由 pinProposalTrees 建引用）
 */
async function rebuildPullRequest(ctx: AskToolContext, w: PendingWrite, st: RebuildState): Promise<Rebuilt> {
  const base = await saveTimeBase(ctx, w, st);
  let fetching = st.fetched.get(base);
  if (!fetching) {
    fetching = fetchOriginBranch(ctx.repo, base, st.signal);
    st.fetched.set(base, fetching);
  }
  await fetching;
  const { proposal, merge } = await buildPullRequestProposal(ctx, { ...w.args, base }, { now: new Date(w.at) });
  if (proposal.source === 'working_tree') Object.assign(proposal, await snapshotWorkingTree(ctx, proposal, st.signal));
  return { proposal: { kind: 'pull_request', status: 'pending', payload: proposal }, merge };
}

/** 保存事务提交后，为 working_tree 来源的 tree 建引用；失败只记日志（tree 在 gc 清理前仍可用，执行时会检查） */
export async function pinProposalTrees(repo: string, dataDir: string, rows: readonly ProposalRow[]): Promise<void> {
  const pinned = rows.flatMap((r) => (r.kind === 'pull_request' && r.payload.tree && !r.payload.unbuilt ? [{ id: r.id, tree: r.payload.tree }] : []));
  if (pinned.length === 0) return;
  const run = await gitRun(repo);
  for (const { id, tree } of pinned) {
    await updateRef(run, proposalRef(dataDir, id), tree).catch((err: Error) => log.warn('proposal_ref_failed', { id, error: err.message.split('\n')[0] }));
  }
}

const cancelled = () => new ProposalError('cancelled', 'cancelled before the change was prepared');

/** 成功的写调用按工具执行时的实际顺序排列：都带 seq 时按它，否则保持开始的顺序 */
export function executionOrder(writes: readonly PendingWrite[]): PendingWrite[] {
  const ok = writes.filter((w) => w.ok);
  return ok.every((w) => w.seq !== undefined) ? [...ok].sort((a, b) => a.seq! - b.seq!) : ok;
}

/**
 * 保存回答前，对每个成功的写调用按磁盘（PR 为最新的 origin/<base>）上的当前内容重新生成修改，按执行顺序叠加：
 * 后一次调用涉及前面某张卡片的文件（或同一分支）时，那张卡片整个并入后一张，不再单独保存；
 * 同会话里还在等确认的修改也照此并入（mergedFrom，保存时改为 dismissed）。
 * 失败的也返回，状态为 failed 并带原因。signal 中止后正在 fetch 的结束，剩下的都记为 cancelled。
 */
export async function rebuildProposals(ctx: AskToolContext, writes: readonly PendingWrite[], opts: { signal?: AbortSignal } = {}): Promise<NewProposal[]> {
  const st: RebuildState = { ...(opts.signal ? { signal: opts.signal } : {}), fetched: new Map() };
  // 和工具执行时一样叠加，但从头记录（不沿用工具执行时的结果），同会话的待确认修改按保存时的状态读
  const fresh: AskToolContext = ctx.write ? { ...ctx, write: { dirs: ctx.write.dirs, ...(ctx.write.sessionId !== undefined ? { sessionId: ctx.write.sessionId } : {}), drafts: new ProposalDrafts() } } : ctx;
  const out: { proposal: NewProposal; group?: number }[] = [];
  for (const w of executionOrder(writes)) {
    try {
      if (opts.signal?.aborted) throw cancelled();
      const r = w.name === PROPOSE_FILE_CHANGES ? await rebuildFiles(fresh, w) : await rebuildPullRequest(fresh, w, st);
      const absorbed = new Set(r.merge?.absorbed ?? []);
      for (let i = out.length - 1; i >= 0; i--) if (out[i]!.group !== undefined && absorbed.has(out[i]!.group!)) out.splice(i, 1);
      const mergedFrom = r.merge?.priorIds.length ? { mergedFrom: r.merge.priorIds } : {};
      out.push({ proposal: { ...r.proposal, ...mergedFrom }, ...(r.merge ? { group: r.merge.group } : {}) });
    } catch (err) {
      const p = unbuilt(w, err);
      log.warn('proposal_rebuild_failed', { tool: w.name, code: p.result?.error?.code });
      out.push({ proposal: p });
    }
  }
  return out.map((o) => o.proposal);
}

/** 日志字段：id、类型、写入根目录名或分支、文件数、状态；不含内容 */
export function proposalLogFields(row: ProposalRow): Record<string, unknown> {
  const target = row.kind === 'files'
    ? { root: row.payload.root, ...(row.payload.root !== 'repo' && row.payload.rootPath ? { rootDir: path.basename(row.payload.rootPath) } : {}) }
    : { base: row.payload.base, branch: row.payload.branch, source: row.payload.source };
  return { id: row.id, kind: row.kind, ...target, files: row.payload.files?.length ?? 0, status: row.status, error: row.result?.error?.code };
}
