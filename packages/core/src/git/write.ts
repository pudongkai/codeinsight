import { execFile } from 'node:child_process';
import { copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { log } from '../log.js';
import { ProposalError } from '../util/failure.js';
import { stopReasonText, stopReason, type StopReason } from '../util/exec-stop.js';
import { GitError, runGit, type RunGitOptions } from './index.js';

/**
 * 本工具代为执行的 git 命令不跑任何钩子（含 --no-verify 管不到的 reference-transaction 等）和 fsmonitor，
 * 不执行仓库里或模型写进去的脚本
 */
const NO_HOOKS = ['-c', `core.hooksPath=${os.devNull}`, '-c', 'core.fsmonitor=false'];

/** 联网的 git 命令每步的时间上限 */
export const GIT_NETWORK_TIMEOUT_MS = 60_000;

/** 命令的程序名（去掉引号、目录和 .exe，小写） */
function programName(command: string): string {
  const m = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  const prog = m?.[1] ?? m?.[2] ?? m?.[3] ?? '';
  return (prog.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');
}

/** 在 ssh 命令后追加不交互的参数：plink / tortoiseplink 用 -batch，其他按 OpenSSH 用 -o BatchMode=yes */
export function batchSsh(command: string): string {
  const name = programName(command);
  return `${command} ${name === 'plink' || name === 'tortoiseplink' ? '-batch' : '-o BatchMode=yes'}`;
}

/**
 * ssh 命令：沿用用户的 GIT_SSH_COMMAND 或 core.sshCommand，在后面加不交互的参数，需要输入密码时直接失败。
 * 只设了 GIT_SSH 时返回 undefined（GIT_SSH_COMMAND 会覆盖它，不能设）
 */
async function batchSshCommand(repo: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const configured = env.GIT_SSH_COMMAND?.trim() || (await runGit(repo, ['config', '--get', 'core.sshCommand']).catch(() => '')).trim();
  if (configured) return batchSsh(configured);
  return env.GIT_SSH?.trim() ? undefined : batchSsh('ssh');
}

/** 联网的 git / gh 命令用的环境变量：不弹出输入提示，需要凭据时直接失败而不是卡住 */
export async function nonInteractiveEnv(repo: string, env: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const ssh = await batchSshCommand(repo, env);
  return { ...env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', ...(ssh ? { GIT_SSH_COMMAND: ssh } : {}) };
}

/** 首行，去掉其中的绝对路径（本地路径的 origin 会出现在错误输出里） */
export function gitErrorSummary(stderr: string): string {
  const line = stderr.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  return line
    .replace(/(^|[\s'"(])\/[^\s'")]+/g, '$1<path>')
    .replace(/(^|[\s'"(])[A-Za-z]:[\\/][^\s'")]*/g, '$1<path>')
    .replace(/^(fatal|error|致命错误|错误)[:：]\s*/, '');
}

/** fetch 失败：message 是给用户看的原因（超时、取消或 git 的错误首行），不含绝对路径 */
export class FetchError extends ProposalError {
  constructor(code: 'fetch_failed' | 'cancelled', message: string) {
    super(code, message);
  }
}

/** 给用户看的失败原因：超时、取消或错误输出的首行（不含绝对路径） */
export function gitFailureReason(err: GitError): string {
  if (err.detail.stopped) return stopReasonText(err.detail.stopped, GIT_NETWORK_TIMEOUT_MS);
  return gitErrorSummary(err.detail.stderr ?? '') || 'unknown error';
}

function fetchFailure(branch: string, err: unknown): FetchError {
  if (!(err instanceof GitError)) return new FetchError('fetch_failed', `git fetch origin ${branch} failed`);
  if (err.detail.stopped === 'aborted') return new FetchError('cancelled', 'cancelled');
  return new FetchError('fetch_failed', `git fetch origin ${branch} failed: ${gitFailureReason(err)}`);
}

/**
 * `git fetch origin +refs/heads/<branch>:refs/remotes/origin/<branch>`：用明确的 refspec 更新本地的 origin/<branch>，
 * 单分支克隆（fetch 配置里没有这个分支）时也会建立。分支名由调用方检查过。失败时抛 FetchError
 */
export async function fetchOriginBranch(repo: string, branch: string, signal?: AbortSignal): Promise<void> {
  const started = Date.now();
  const refspec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
  try {
    await runGit(repo, [...NO_HOOKS, 'fetch', '--no-tags', 'origin', '--end-of-options', refspec], {
      env: await nonInteractiveEnv(repo), timeoutMs: GIT_NETWORK_TIMEOUT_MS, ...(signal ? { signal } : {}),
    });
  } catch (err) {
    const f = fetchFailure(branch, err);
    log.warn('git_fetch_failed', { branch, code: f.code, ms: Date.now() - started });
    throw f;
  }
  log.info('git_fetch', { branch, ms: Date.now() - started });
}

// ---------- 不碰工作区的提交和推送（建 PR 用） ----------

/** 一组写操作共用的执行环境：仓库根目录、非交互环境变量、取消信号。每条命令 60 秒超时 */
export interface GitRun {
  repo: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export async function gitRun(repo: string, signal?: AbortSignal): Promise<GitRun> {
  return { repo, env: await nonInteractiveEnv(repo), ...(signal ? { signal } : {}) };
}

/** 改用临时索引文件：read-tree、add、update-index、write-tree 都只动这个文件，不碰仓库的索引和工作区 */
export function withIndexFile(run: GitRun, indexFile: string): GitRun {
  return { ...run, env: { ...run.env, GIT_INDEX_FILE: indexFile } };
}

function git(run: GitRun, args: string[], extra: Pick<RunGitOptions, 'input'> = {}): Promise<string> {
  return runGit(run.repo, [...NO_HOOKS, ...args], { env: run.env, timeoutMs: GIT_NETWORK_TIMEOUT_MS, ...(run.signal ? { signal: run.signal } : {}), ...extra });
}

/** `git hash-object -w --stdin --no-filters`：按原样写入对象库，返回 blob 编号 */
export async function hashObject(run: GitRun, content: string | Buffer): Promise<string> {
  return (await git(run, ['hash-object', '-w', '--no-filters', '--stdin'], { input: content })).trim();
}

/** 把提交或 tree 读进（临时）索引 */
export async function readTreeIntoIndex(run: GitRun, treeish: string): Promise<void> {
  await git(run, ['read-tree', '--end-of-options', treeish]);
}

/** `git update-index --add --cacheinfo <mode>,<blob>,<path>` */
export async function setIndexEntry(run: GitRun, mode: string, blob: string, file: string): Promise<void> {
  await git(run, ['update-index', '--add', '--cacheinfo', `${mode},${blob},${file}`]);
}

export async function writeTree(run: GitRun): Promise<string> {
  return (await git(run, ['write-tree'])).trim();
}

/** `git commit-tree`：作者、签名按用户的 git 配置 */
export async function commitTree(run: GitRun, tree: string, parent: string, message: string): Promise<string> {
  return (await git(run, ['commit-tree', '-p', parent, '-m', message, '--end-of-options', tree])).trim();
}

/** 对象是否存在且类型为 type */
export async function objectExists(run: GitRun, oid: string, type: 'tree' | 'commit'): Promise<boolean> {
  return git(run, ['cat-file', '-e', '--end-of-options', `${oid}^{${type}}`]).then(() => true, () => false);
}

export async function updateRef(run: GitRun, ref: string, oid: string): Promise<void> {
  await git(run, ['update-ref', '--end-of-options', ref, oid]);
}

/** 删除引用；引用不存在时不报错 */
export async function deleteRef(run: GitRun, ref: string): Promise<void> {
  await git(run, ['update-ref', '-d', '--end-of-options', ref]);
}

export interface TreeChange {
  path: string;
  /** A 新增、M 修改、D 删除、T 类型变化 */
  status: 'A' | 'M' | 'D' | 'T';
  oldMode: string;
  newMode: string;
}

/** 两个 tree / 提交之间的改动文件（不识别重命名），带新旧 mode */
export async function treeChanges(run: GitRun, from: string, to: string): Promise<TreeChange[]> {
  const out = await git(run, ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-relative', '--ignore-submodules=none', '--end-of-options', from, to, '--']);
  const tokens = out.split('\0').filter((t) => t !== '');
  const changes: TreeChange[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const [oldMode, newMode, , , status] = tokens[i]!.slice(1).split(' ') as [string, string, string, string, string];
    changes.push({ path: tokens[i + 1]!, status: status[0] as TreeChange['status'], oldMode, newMode });
  }
  return changes;
}

/** 推送仓库（地址）上这个分支当前指向的提交，分支不存在时为 undefined */
export async function remoteBranchHead(run: GitRun, remote: string, branch: string): Promise<string | undefined> {
  const ref = `refs/heads/${branch}`;
  const out = await git(run, ['ls-remote', '--heads', '--end-of-options', remote, ref]);
  const line = out.split('\n').find((l) => l.split('\t')[1] === ref);
  return line?.split('\t')[0];
}

/** origin 的默认分支（`ls-remote --symref origin HEAD`），取不到为 undefined */
async function remoteDefaultBranch(run: GitRun): Promise<string | undefined> {
  const out = await git(run, ['ls-remote', '--symref', 'origin', 'HEAD']);
  const m = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(out);
  return m?.[1];
}

/** 本地记录的远程默认分支（refs/remotes/origin/HEAD），不联网 */
async function localDefaultBranch(repo: string): Promise<string | undefined> {
  const ref = (await runGit(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).catch(() => '')).trim();
  const name = ref.replace(/^refs\/remotes\/origin\//, '');
  return name && name !== ref ? name : undefined;
}

/** gh 记录的仓库默认分支（`gh repo view --json defaultBranchRef`） */
async function ghDefaultBranch(run: GitRun): Promise<string | undefined> {
  const out = await runGh(run, ['repo', 'view', '--json', 'defaultBranchRef']);
  const name = (JSON.parse(out) as { defaultBranchRef?: { name?: unknown } }).defaultBranchRef?.name;
  return typeof name === 'string' && name !== '' ? name : undefined;
}

/**
 * origin 的默认分支，工具执行时和保存时共用：先看本地记录的 origin/HEAD；online 时（保存时）再依次问
 * `git ls-remote --symref origin HEAD` 和 `gh repo view`。都取不到时为 undefined，名字由调用方检查
 */
export async function originDefaultBranch(repo: string, opts: { online?: { signal?: AbortSignal } } = {}): Promise<string | undefined> {
  const local = await localDefaultBranch(repo);
  if (local || !opts.online) return local;
  const run = await gitRun(repo, opts.online.signal);
  const remote = await remoteDefaultBranch(run).catch(() => undefined);
  if (remote) return remote;
  const viaGh = await ghDefaultBranch(run).catch(() => undefined);
  log.info('origin_default_branch', { source: viaGh ? 'gh' : 'none' });
  return viaGh;
}

/** `git push --no-verify <remote> <commit>:refs/heads/<branch>`：不跑 pre-push 钩子，不带标签和子模块 */
export async function pushCommit(run: GitRun, remote: string, commit: string, branch: string): Promise<void> {
  await git(run, ['push', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', '--end-of-options', remote, `${commit}:refs/heads/${branch}`]);
}

// ---------- 工作区未提交的改动生成 tree（working_tree 来源的 PR） ----------

/** 工作区的改动不能用来建 PR（LFS 文件、新加的嵌套仓库等），message 是给用户看的原因 */
export class WorkingTreeRejected extends ProposalError {
  constructor(code: 'lfs_not_supported' | 'nested_repository', message: string) {
    super(code, message);
  }
}

/** 写临时索引时不拆出共享索引文件到 .git 里 */
const INDEX_CONFIG = ['-c', 'core.splitIndex=false'];

/**
 * 临时索引的起点：复制用户的索引（保留 skip-worktree / assume-unchanged 标记，已暂存的改动也算未提交的改动）；
 * 只要部分路径时，其余路径恢复为起点提交的内容。用户还没有索引时读入起点提交
 */
async function seedIndex(run: GitRun, idx: GitRun, indexFile: string, start: string, paths: readonly string[]): Promise<void> {
  const userIndex = path.resolve(run.repo, (await git(run, ['rev-parse', '--git-path', 'index'])).trim());
  try {
    await copyFile(userIndex, indexFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await readTreeIntoIndex(idx, start);
    return;
  }
  if (paths.length > 0) {
    await git(idx, [...INDEX_CONFIG, '--no-literal-pathspecs', 'reset', '-q', start, '--', ':(literal).', ...paths.map((p) => `:(exclude,literal)${p}`)]);
  }
}

/**
 * `git add -A`：把工作区里这些路径（按字面匹配，空为全部）的改动记进临时索引，含未跟踪、未忽略的文件。
 * 不跑钩子和 fsmonitor，不写共享索引；符号链接按链接本身记录。excludeDir 为仓库内的数据目录，不读也不写进对象库。
 * 要同时排除目录，所以每个路径用 `:(literal)` 标记按字面匹配，而不是全局的 --literal-pathspecs
 */
async function addWorkingTree(idx: GitRun, paths: readonly string[], excludeDir?: string): Promise<void> {
  const specs = (paths.length > 0 ? paths : ['.']).map((p) => `:(literal)${p}`);
  await git(idx, [...INDEX_CONFIG, '--no-literal-pathspecs', 'add', '-A', '--', ...specs, ...(excludeDir ? [`:(exclude,literal)${excludeDir}`] : [])]);
}

/** 新加的嵌套仓库（起点里不是子模块的 gitlink）和 LFS 管理的文件不能放进 PR */
async function rejectUnsupported(run: GitRun, changes: readonly TreeChange[]): Promise<void> {
  const nested = changes.find((c) => c.newMode === '160000' && c.oldMode !== '160000');
  if (nested) throw new WorkingTreeRejected('nested_repository', `${nested.path} is a nested git repository, not a file; it cannot be put into the pull request`);
  const kept = changes.filter((c) => c.status !== 'D').map((c) => c.path);
  if (kept.length === 0) return;
  const out = (await git(run, ['check-attr', '-z', 'filter', '--', ...kept])).split('\0');
  for (let i = 0; i + 2 < out.length; i += 3) {
    if (out[i + 2] === 'lfs') throw new WorkingTreeRejected('lfs_not_supported', `${out[i]} is stored with Git LFS, which is not supported here; create this pull request manually`);
  }
}

/**
 * 工作区未提交的改动（含已暂存、未跟踪未忽略的文件）相对起点提交生成 tree，不碰用户的索引和工作区。
 * indexFile 为临时索引文件的路径（调用方负责删除）
 */
export async function collectWorkingTree(run: GitRun, indexFile: string, start: string, paths: readonly string[], excludeDir?: string): Promise<{ tree: string; changes: TreeChange[] }> {
  const idx = withIndexFile(run, indexFile);
  await seedIndex(run, idx, indexFile, start, paths);
  await addWorkingTree(idx, paths, excludeDir);
  const tree = await writeTree(idx);
  const changes = await treeChanges(run, start, tree);
  await rejectUnsupported(run, changes);
  return { tree, changes };
}

// ---------- gh ----------

/** gh 命令失败：stopped 为超时或取消，stderr 为原始错误输出 */
export class GhError extends Error {
  constructor(readonly stderr: string, readonly stopped?: StopReason) {
    super(stderr);
  }
}

/** execFile 调 gh：不经 shell，cwd 为仓库根，60 秒超时，用 run 的非交互环境变量 */
export function runGh(run: GitRun, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, {
      cwd: run.repo, env: { ...run.env, GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      timeout: GIT_NETWORK_TIMEOUT_MS, killSignal: 'SIGKILL', ...(run.signal ? { signal: run.signal } : {}),
    }, (err, stdout, stderr) => (err ? reject(new GhError(stderr || err.message, stopReason(err, run.signal))) : resolve(stdout)));
  });
}

/** 给用户看的 gh 失败原因：超时、取消或错误输出的首行（不含绝对路径） */
export function ghFailureReason(err: unknown): string {
  if (!(err instanceof GhError)) return (err as Error).message.split('\n')[0]!;
  if (err.stopped) return stopReasonText(err.stopped, GIT_NETWORK_TIMEOUT_MS);
  return gitErrorSummary(err.stderr) || 'unknown error';
}
