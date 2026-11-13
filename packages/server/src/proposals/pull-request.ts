import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AskToolFailure, checkBranchName, checkWritePath, commitTree, deleteRef, GhError, ghFailureReason, gitRun, hashObject, knownFailure,
  log, objectExists, ProposalError, proposalLogFields, proposalRef, proposalView, pushCommit, readTreeIntoIndex, remoteBranchHead, repoRoot, runGh, runGit,
  setIndexEntry, treeEntries, withIndexFile, writeTree,
} from '@codeinsight/core';
import type { GitRun, ProposalRow, ProposalView, PullRequestProposal, Store } from '@codeinsight/core';
import { onPath } from '../dir-picker.js';

/** 加在 PR 正文末尾 */
export const PR_FOOTER = '由 CodeInsight 问答生成';

/** 建 PR 的某一步失败：code 和原因（不含绝对路径）记进结果 */
export class PullRequestError extends ProposalError {}

/** 已完成的步骤：提交号、是否已推送。失败后重试从这里继续 */
interface PrProgress {
  commit?: string;
  pushed?: boolean;
}

/** GitHub 上的仓库：主机名和 owner/name */
export interface GitHubRepo {
  host: string;
  repo: string;
}

/** 推送到哪里：推送地址（已展开 insteadOf / pushInsteadOf）；推送仓库和 PR 目标仓库不同时为推送仓库的 owner */
interface PushTarget {
  url: string;
  headOwner?: string;
}

/** 执行时的环境：仓库和数据目录（引用名按数据目录区分） */
export interface PullRequestEnv {
  repo: string;
  dataDir: string;
}

/** 正在执行的建 PR，serve 退出时结束它们的 git / gh 子进程 */
const running = new Set<AbortController>();

/** 结束所有正在执行的建 PR（serve 退出时调用），返回结束了几个 */
export function abortPullRequests(): number {
  const n = running.size;
  for (const c of running) c.abort();
  return n;
}

// ---------- gh ----------

/** 从 origin 地址解析 GitHub 主机和 owner/name；ssh 别名（主机名不带点）等解析不出时为 undefined */
export function parseGitHubRemote(url: string): GitHubRepo | undefined {
  const m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(url) ?? /^(?:[^@/:]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(url);
  if (!m) return undefined;
  const host = m[1]!.toLowerCase() === 'ssh.github.com' ? 'github.com' : m[1]!.toLowerCase();
  const parts = m[2]!.replace(/\/+$/, '').replace(/\.git$/, '').split('/');
  if (!host.includes('.') || parts.length !== 2 || parts.some((p) => !/^[A-Za-z0-9_.-]+$/.test(p) || p.startsWith('-'))) return undefined;
  return { host, repo: parts.join('/') };
}

/** origin 的原始地址（不展开 insteadOf）和展开后的地址，依次尝试解析；都不行时问 gh */
async function githubRepo(run: GitRun): Promise<GitHubRepo> {
  const raw = (await runGit(run.repo, ['config', '--get', 'remote.origin.url']).catch(() => '')).trim();
  if (!raw) throw new PullRequestError('origin_missing', 'the repository has no origin remote');
  const expanded = (await runGit(run.repo, ['remote', 'get-url', 'origin']).catch(() => '')).trim();
  const parsed = parseGitHubRemote(raw) ?? parseGitHubRemote(expanded);
  if (parsed) return parsed;
  const out = await runGh(run, ['repo', 'view', '--json', 'nameWithOwner,url']).catch(() => '');
  try {
    const v = JSON.parse(out) as { nameWithOwner?: string; url?: string };
    const host = v.url ? new URL(v.url).hostname : '';
    if (host && v.nameWithOwner && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v.nameWithOwner)) return { host, repo: v.nameWithOwner };
  } catch {
    // 下面统一报错
  }
  throw new PullRequestError('origin_unknown', 'could not tell which GitHub repository origin points to; check the origin URL or run gh repo set-default');
}

const gitOut = (run: GitRun, args: string[]) => runGit(run.repo, args).then((o) => o.trim(), () => '');

/**
 * 推送仓库：`git remote get-url --push origin` 的第一个地址。能解析出 GitHub 仓库时和 PR 目标仓库比较，
 * 不同则 PR 的 head 带上推送仓库的 owner；解析不出时只接受和 origin 的拉取地址相同
 */
async function pushTarget(run: GitRun, target: GitHubRepo): Promise<PushTarget> {
  const url = (await gitOut(run, ['remote', 'get-url', '--push', 'origin'])).split('\n')[0]!;
  if (!url) throw new PullRequestError('origin_missing', 'the repository has no origin remote');
  const raw = (await gitOut(run, ['config', '--get', 'remote.origin.pushurl'])) || (await gitOut(run, ['config', '--get', 'remote.origin.url']));
  const parsed = parseGitHubRemote(raw.split('\n')[0]!) ?? parseGitHubRemote(url);
  if (parsed) {
    if (parsed.host !== target.host) throw new PullRequestError('push_target_mismatch', `origin pushes to ${parsed.host} but the pull request would be opened on ${target.host}`);
    return parsed.repo.toLowerCase() === target.repo.toLowerCase() ? { url } : { url, headOwner: parsed.repo.split('/')[0]! };
  }
  if (url === (await gitOut(run, ['remote', 'get-url', 'origin']))) return { url };
  throw new PullRequestError('push_target_unknown', 'origin pushes to another repository whose GitHub owner cannot be determined; create this pull request manually');
}

/** 前置检查：gh 在 PATH 里，能确定 GitHub 仓库，且已登录这个主机 */
async function ghPreflight(run: GitRun): Promise<GitHubRepo> {
  if (!(await onPath('gh', run.env))) throw new PullRequestError('gh_missing', 'the GitHub CLI (gh) is not installed or not on PATH');
  const target = await githubRepo(run);
  try {
    await runGh(run, ['auth', 'status', '--hostname', target.host]);
  } catch (err) {
    if (err instanceof GhError && err.stopped) throw new PullRequestError(err.stopped === 'aborted' ? 'cancelled' : 'gh_failed', `gh auth status: ${ghFailureReason(err)}`);
    throw new PullRequestError('gh_not_authenticated', `gh is not logged in to ${target.host}; run gh auth login`);
  }
  return target;
}

// ---------- 提交和推送 ----------

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** 执行时再检查一遍：分支名、路径、起点和 tree 编号 */
async function recheck(repo: string, p: PullRequestProposal): Promise<void> {
  await checkBranchName(repo, 'base', p.base);
  await checkBranchName(repo, 'branch', p.branch);
  if (p.branch === p.base) throw new AskToolFailure('invalid_args', '`branch` must differ from `base`');
  if (!OID.test(p.startCommit)) throw new PullRequestError('invalid_proposal', 'the starting commit of the proposal is missing');
  if (p.source === 'edits') {
    for (const f of p.files ?? []) checkWritePath(f.path);
  } else if (!p.tree || !OID.test(p.tree)) {
    throw new PullRequestError('invalid_proposal', 'the saved changes of the proposal are missing');
  }
}

/** edits 来源：临时索引读入起点，写入每个文件的内容（已有文件沿用起点的 mode，新文件 100644），得到 tree */
async function editsTree(run: GitRun, p: PullRequestProposal, tmp: string): Promise<string> {
  const files = p.files ?? [];
  const entries = await treeEntries(run.repo, p.startCommit, files.map((f) => f.path));
  const idx = withIndexFile(run, path.join(tmp, 'index'));
  await readTreeIntoIndex(idx, p.startCommit);
  for (const f of files) {
    const blob = await hashObject(idx, f.content);
    await setIndexEntry(idx, entries.get(f.path)?.mode ?? '100644', blob, f.path);
  }
  return writeTree(idx);
}

/** 生成提交（不碰工作区和仓库索引）：作者和签名按用户的 git 配置 */
async function createCommit(run: GitRun, p: PullRequestProposal, tmp: string): Promise<string> {
  let tree: string;
  if (p.source === 'edits') {
    tree = await editsTree(run, p, tmp);
  } else {
    if (!(await objectExists(run, p.tree!, 'tree'))) throw new PullRequestError('tree_missing', 'the saved uncommitted changes are no longer in the repository; ask again');
    tree = p.tree!;
  }
  return commitTree(run, tree, p.startCommit, p.title);
}

/** 推送仓库上的分支已是这个提交时跳过（重试），是别的提交时失败，不存在时推送 */
async function pushBranch(run: GitRun, push: PushTarget, branch: string, commit: string): Promise<'pushed' | 'skipped'> {
  const remote = await remoteBranchHead(run, push.url, branch);
  if (remote === commit) return 'skipped';
  if (remote) throw new PullRequestError('branch_exists', `branch ${branch} already exists on origin with different content; choose another branch name`);
  await pushCommit(run, push.url, commit, branch);
  return 'pushed';
}

// ---------- 建 PR ----------

function prBody(body: string): string {
  const text = body.trimEnd();
  return `${text ? `${text}\n\n---\n` : ''}${PR_FOOTER}\n`;
}

function prUrl(out: string): string | undefined {
  return out.match(/https?:\/\/\S+/g)?.at(-1);
}

/** PR 要合入的分支：推送仓库和目标仓库不同时为 owner:branch */
interface PrHead {
  head: string;
  commit: string;
}

/** 这个分支已有的、仍打开且指向本次提交的 PR（重试时 pr create 会因已存在而失败）；已合并、已关闭或内容不同的不算 */
async function existingPr(run: GitRun, target: GitHubRepo, head: PrHead): Promise<string | undefined> {
  const out = await runGh(run, ['pr', 'view', `--repo=${target.repo}`, '--json', 'url,state,headRefOid', '--', head.head]).catch(() => '');
  try {
    const v = JSON.parse(out) as { url?: unknown; state?: unknown; headRefOid?: unknown };
    return v.state === 'OPEN' && v.headRefOid === head.commit && typeof v.url === 'string' ? prUrl(v.url) : undefined;
  } catch {
    return undefined;
  }
}

/** `gh pr create`：值用 = 连写，以 - 开头的标题不会被当成参数；已存在时取已有 PR 的链接 */
async function openPullRequest(run: GitRun, target: GitHubRepo, p: PullRequestProposal, head: PrHead, tmp: string): Promise<string> {
  const bodyFile = path.join(tmp, 'body.md');
  await writeFile(bodyFile, prBody(p.body));
  try {
    const out = await runGh(run, ['pr', 'create', `--repo=${target.repo}`, `--base=${p.base}`, `--head=${head.head}`, `--title=${p.title}`, '--body-file', bodyFile]);
    const url = prUrl(out);
    if (url) return url;
    throw new PullRequestError('pr_create_failed', 'gh pr create did not print a pull request link');
  } catch (err) {
    if (err instanceof PullRequestError) throw err;
    const url = err instanceof GhError && !err.stopped ? await existingPr(run, target, head) : undefined;
    if (url) return url;
    const code = err instanceof GhError && err.stopped === 'aborted' ? 'cancelled' : 'pr_create_failed';
    throw new PullRequestError(code, `gh pr create failed: ${ghFailureReason(err)}`);
  }
}

// ---------- 执行 ----------

interface Step {
  name: string;
  started: number;
}

/** 按步骤执行，progress 每完成一步就保存 */
async function runSteps(store: Store, row: ProposalRow & { kind: 'pull_request' }, run: GitRun, step: Step): Promise<string> {
  const p = row.payload;
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'codeinsight-pr-'));
  const next = (name: string) => {
    log.info('proposal_apply_step', { id: row.id, branch: p.branch, step: step.name, ms: Date.now() - step.started });
    Object.assign(step, { name, started: Date.now() });
  };
  try {
    let progress = (row.progress ?? {}) as PrProgress;
    await recheck(run.repo, p);
    next('preflight');
    const target = await ghPreflight(run);
    const push = await pushTarget(run, target);
    next('commit');
    if (!progress.commit) {
      progress = { commit: await createCommit(run, p, tmp) };
      store.proposals.setProgress(row.id, { ...progress });
    }
    next('push');
    const pushed = await pushBranch(run, push, p.branch, progress.commit!);
    if (!progress.pushed) store.proposals.setProgress(row.id, { ...progress, pushed: true });
    log.info('proposal_push', { id: row.id, branch: p.branch, result: pushed });
    next('pr_create');
    const head = { head: push.headOwner ? `${push.headOwner}:${p.branch}` : p.branch, commit: progress.commit! };
    return await openPullRequest(run, target, p, head, tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** 失败原因：不含绝对路径和凭据 */
function failure(err: unknown, step: string): { code: string; message: string } {
  const known = knownFailure(err, step);
  if (known) return known;
  log.error('proposal_apply_error', { error: (err as Error).message.split('\n')[0] });
  return { code: 'internal_error', message: 'internal error while creating the pull request' };
}

/** 删除 working_tree 来源保存 tree 用的引用；失败只记日志 */
export async function dropProposalRef(env: PullRequestEnv, row: ProposalRow): Promise<void> {
  if (row.kind !== 'pull_request' || row.payload.source !== 'working_tree') return;
  try {
    await deleteRef(await gitRun(env.repo), proposalRef(env.dataDir, row.id));
  } catch (err) {
    log.warn('proposal_ref_delete_failed', { id: row.id, error: (err as Error).message.split('\n')[0] });
  }
}

/**
 * 建 PR（记录已改为 applying）：生成提交、推送新分支、gh pr create。不建本地分支、不检出、不跑钩子。
 * 成功记 applied 和链接并删除引用；失败记 failed 和原因，progress 保留供重试
 */
export async function applyPullRequest(store: Store, row: ProposalRow & { kind: 'pull_request' }, env: PullRequestEnv): Promise<ProposalView> {
  const controller = new AbortController();
  running.add(controller);
  const step: Step = { name: 'start', started: Date.now() };
  const started = Date.now();
  const fields = { ...proposalLogFields(row), status: undefined };
  try {
    const root = await repoRoot(env.repo);
    const url = await runSteps(store, row, await gitRun(root, controller.signal), step);
    store.proposals.finishApplying(row.id, 'applied', { url });
    log.info('proposal_apply', { ...fields, step: 'done', result: 'applied', ms: Date.now() - started });
    await dropProposalRef({ repo: root, dataDir: env.dataDir }, row);
  } catch (err) {
    const error = failure(err, step.name);
    store.proposals.finishApplying(row.id, 'failed', { error });
    log.warn('proposal_apply', { ...fields, step: step.name, result: 'failed', code: error.code, ms: Date.now() - started });
  } finally {
    running.delete(controller);
  }
  return proposalView(store.proposals.get(row.id)!);
}
