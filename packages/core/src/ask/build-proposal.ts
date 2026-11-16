import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { sha1 } from '../util/hash.js';
import { GitError, readBlob, resolveRef, runGit, treeEntries, type TreeEntry } from '../git/index.js';
import { originDefaultBranch } from '../git/write.js';
import { log } from '../log.js';
import { codeinsightHome } from '../settings/index.js';
import { applyEdits, decodeTextFile, withBom, type TextEdit } from './apply-edits.js';
import { mergeNote, pathKey, ProposalDrafts, unionFiles, type MergeInfo, type PullRequestGroup } from './proposal-drafts.js';
import { isSensitivePath } from './sensitive.js';
import { argsObject, AskToolFailure, optString, reqString, type ToolArgs } from './tool-args.js';
import type { AskToolContext, WriteToolsContext } from './tool-context.js';
import { resolveWriteRoot, type WriteRoot } from './write-roots.js';
import { checkWritePath, resolveWriteTarget, WriteNotAllowedError, type WriteScope } from './write-scope.js';

/** 一次最多修改的文件数 */
export const MAX_PROPOSAL_FILES = 20;
/** 单次写工具参数合计的字符上限（按 4096 token 输出上限估算），超过时让模型拆成多次调用 */
export const MAX_WRITE_ARGS_CHARS = 6000;
/** edits 能修改的文件大小上限 */
export const MAX_EDIT_FILE_BYTES = 1024 * 1024;

/** 一个文件修改后的结果 */
export interface ProposedFile {
  /** 相对写入根目录，统一用 / */
  path: string;
  isNew: boolean;
  /** 修改后的完整内容（保留原文件的 BOM 和换行符） */
  content: string;
  /** 生成时磁盘上（PR 为起点提交上）的内容 sha1，新文件为 null */
  baseSha1: string | null;
  /** 快照里的内容和修改所基于的内容不一致；快照里没有该文件时不设 */
  staleSnapshot?: boolean;
  sensitive?: boolean;
}

export interface FilesProposal {
  root: string;
  rootPath: string;
  summary: string;
  files: ProposedFile[];
}

export interface PullRequestProposal {
  title: string;
  body: string;
  base: string;
  branch: string;
  source: 'edits' | 'working_tree';
  /** edits 来源为 origin/<base>，working_tree 来源为 HEAD */
  startCommit: string;
  files?: ProposedFile[];
  /** working_tree 来源要提交的路径，空为全部 */
  paths?: string[];
  /** working_tree 来源：保存时用临时索引生成的 tree，由 refs/codeinsight/proposals/<id> 引用 */
  tree?: string;
  /** working_tree 来源：相对起点的改动文件，供卡片显示 */
  changes?: { path: string; status: 'A' | 'M' | 'D' | 'T' }[];
  /** working_tree 来源：HEAD 上还没推送到 origin/<base> 的提交（一行标题） */
  unpushedCommits?: string[];
}

export interface BuiltProposal<P> {
  proposal: P;
  /** 要告诉模型的提示（如文件在建索引后改过） */
  notes: string[];
  /** 这次调用在本次问答里的编号，以及和哪些修改合并成了一张卡片 */
  merge: MergeInfo;
}

interface FileArg {
  path: string;
  create?: string;
  edits?: TextEdit[];
}

const bad = (message: string) => new AskToolFailure('invalid_args', message);

function writeContext(ctx: AskToolContext): WriteToolsContext {
  if (!ctx.write) throw bad('write tools are not available in this conversation');
  return ctx.write;
}

/** 拆成多次调用时的说法，和叠加的实现一致 */
const SPLIT_HINT = 'split the change into several smaller calls: a later call can keep editing a file proposed by an earlier call '
  + '(its `old` may quote text added earlier), and pull request calls with the same `branch` add to one pull request';

function checkArgsSize(args: ToolArgs): void {
  const n = JSON.stringify(args).length;
  if (n > MAX_WRITE_ARGS_CHARS) throw bad(`the arguments are too large (${n} characters, at most ${MAX_WRITE_ARGS_CHARS}); ${SPLIT_HINT}`);
}

/** edits 能修改的文件大小检查（磁盘、起点提交和本次问答已生成的内容共用） */
function checkEditSize(rel: string, bytes: number): void {
  if (bytes > MAX_EDIT_FILE_BYTES) throw new AskToolFailure('file_too_large', `${rel}: the file is too large to edit`);
}

/** 本次问答的写工具结果（第一次用时建立） */
function draftsOf(write: WriteToolsContext): ProposalDrafts {
  write.drafts ??= new ProposalDrafts();
  return write.drafts;
}

/** 同会话里还在等确认的修改（第一次调用时读一次），后面的调用涉及同一文件或分支时并入 */
function loadSessionPending(ctx: AskToolContext, drafts: ProposalDrafts): void {
  const sessionId = ctx.write?.sessionId;
  drafts.loadPending(() => (sessionId === undefined ? [] : ctx.store.proposals.pendingForSession(sessionId)));
}

function parseEdits(raw: unknown, file: string): TextEdit[] {
  if (!Array.isArray(raw) || raw.length === 0) throw bad(`${file}: \`edits\` must be a non-empty array of {old, new}`);
  return raw.map((e, i) => {
    const { old, new: next } = (e ?? {}) as { old?: unknown; new?: unknown };
    if (typeof old !== 'string' || old === '' || typeof next !== 'string') throw bad(`${file}: edit ${i + 1} needs a non-empty \`old\` string and a \`new\` string`);
    return { old, new: next };
  });
}

function parseFile(raw: unknown): FileArg {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('each item of `files` must be an object');
  const f = raw as Record<string, unknown>;
  if (typeof f.path !== 'string' || f.path === '') throw bad('each file needs a `path` string');
  const hasCreate = f.create !== undefined && f.create !== null;
  const hasEdits = f.edits !== undefined && f.edits !== null;
  if (hasCreate === hasEdits) throw bad(`${f.path}: give exactly one of \`create\` and \`edits\``);
  if (hasCreate && typeof f.create !== 'string') throw bad(`${f.path}: \`create\` must be a string`);
  return hasCreate ? { path: f.path, create: f.create as string } : { path: f.path, edits: parseEdits(f.edits, f.path) };
}

/** files 参数：1 到 MAX_PROPOSAL_FILES 个，同一路径（不区分大小写）不能出现两次 */
function parseFiles(raw: unknown): FileArg[] {
  if (!Array.isArray(raw) || raw.length === 0) throw bad('`files` must be a non-empty array');
  if (raw.length > MAX_PROPOSAL_FILES) throw bad(`at most ${MAX_PROPOSAL_FILES} files per call; ${SPLIT_HINT}`);
  const files = raw.map(parseFile);
  const seen = new Set<string>();
  for (const f of files) {
    const key = pathKey(f.path);
    if (seen.has(key)) throw bad(`${f.path}: the same file appears twice`);
    seen.add(key);
  }
  return files;
}

function sensitive(rel: string): { sensitive?: true } {
  return isSensitivePath(rel) ? { sensitive: true } : {};
}

/** 快照里有这个文件时比较 content_hash 和修改所基于的内容 */
function staleField(ctx: AskToolContext, rel: string, baseSha1: string, notes: string[]): { staleSnapshot?: boolean } {
  const row = ctx.store.getFile(ctx.snapshot.id, rel);
  if (!row) return {};
  const stale = row.contentHash !== baseSha1;
  if (stale) notes.push(`${rel}: the file changed after indexing; the edits were applied to its current content`);
  return { staleSnapshot: stale };
}

/** 在原内容上应用 edits；不是 UTF-8 文本的文件拒绝 */
function editedContent(rel: string, bytes: Buffer, edits: TextEdit[]): string {
  const file = decodeTextFile(bytes);
  if (!file) throw bad(`${rel}: the file is not UTF-8 text and cannot be edited`);
  return withBom(applyEdits(file, edits), file.bom);
}

function newFile(rel: string, content: string): ProposedFile {
  return { path: rel, isNew: true, content, baseSha1: null, ...sensitive(rel) };
}

/**
 * 本次问答里前面的调用已生成过这个文件：在生成的内容上继续应用 edits，isNew、baseSha1 等沿用前面的，
 * 执行时一次写入全部修改
 */
function onDraft(prev: ProposedFile, f: FileArg): ProposedFile {
  if (f.create !== undefined) throw bad(`${f.path}: the file was already proposed earlier in this conversation; use edits to change it further`);
  const bytes = Buffer.from(prev.content, 'utf8');
  checkEditSize(f.path, bytes.length);
  return { ...prev, content: editedContent(f.path, bytes, f.edits!) };
}

// ---------- propose_file_changes ----------

async function readForEdit(abs: string, rel: string): Promise<Buffer> {
  const bytes = await readFile(abs);
  checkEditSize(rel, bytes.length);
  return bytes;
}

/**
 * 写入根目录的检查范围：不能写数据目录和 CODEINSIGHT_HOME；仓库以外的根目录再挡住主目录下的配置目录
 * （--add-dir 本身已不在其中，这里防的是根目录里的符号链接）。生成修改和执行写入共用
 */
export function writeScopeFor(root: WriteRoot, dataDir: string): WriteScope {
  return { root: root.path, excluded: [dataDir, codeinsightHome()], ...(root.repo ? {} : { home: os.homedir() }) };
}

async function proposeDiskFile(ctx: AskToolContext, root: WriteRoot, f: FileArg, notes: string[], prev: ProposedFile | undefined): Promise<ProposedFile> {
  // 前面生成过的文件（如本次新建的）可以继续修改，内容是模型自己给的
  if (!prev && f.edits && !root.repo) throw new WriteNotAllowedError(`${f.path}: outside the repository only new files can be created (use create)`);
  if (!prev && f.edits && !ctx.sendSource) throw bad(`${f.path}: source sending is turned off, so only new files can be created (use create)`);
  const target = await resolveWriteTarget(writeScopeFor(root, ctx.layout.root), f.path);
  if (prev) return onDraft(prev, f);
  if (f.create !== undefined) {
    if (target.exists && !root.repo) throw new WriteNotAllowedError(`${f.path}: the file already exists; files outside the repository cannot be overwritten`);
    if (target.exists) throw bad(`${f.path}: the file already exists; use edits to change it`);
    return newFile(f.path, f.create);
  }
  if (!target.exists) throw new AskToolFailure('not_found', `${f.path}: no such file; use create for a new file`);
  const bytes = await readForEdit(target.abs, f.path);
  const baseSha1 = sha1(bytes);
  const content = editedContent(f.path, bytes, f.edits!);
  return { path: f.path, isNew: false, content, baseSha1, ...(root.repo ? staleField(ctx, f.path, baseSha1, notes) : {}), ...sensitive(f.path) };
}

/**
 * propose_file_changes：检查参数和路径，按磁盘上的当前内容预演 edits，算出修改后的内容。不写盘。
 * 参数或路径不合法时抛 AskToolFailure / WriteNotAllowedError。
 */
export async function buildFilesProposal(ctx: AskToolContext, input: unknown): Promise<BuiltProposal<FilesProposal>> {
  const drafts = draftsOf(writeContext(ctx));
  return drafts.serial(() => buildFiles(ctx, input, drafts));
}

async function buildFiles(ctx: AskToolContext, input: unknown, drafts: ProposalDrafts): Promise<BuiltProposal<FilesProposal>> {
  const args = argsObject(input);
  checkArgsSize(args);
  const summary = reqString(args, 'summary');
  const root = resolveWriteRoot(optString(args, 'root'), ctx.repo, writeContext(ctx).dirs);
  const files = parseFiles(args.files);
  loadSessionPending(ctx, drafts);
  const groups = drafts.fileGroupsFor(root.name, root.path, files.map((f) => f.path));
  // 涉及前面某组的文件时整组并进来：文件取并集，同一文件在前面的内容上继续修改
  const merged = unionFiles(groups);
  const notes: string[] = [];
  for (const f of files) {
    const key = pathKey(f.path);
    merged.set(key, await proposeDiskFile(ctx, root, f, notes, merged.get(key)));
  }
  const merge = drafts.commitFiles({ root: root.name, rootPath: root.path, files: merged }, summary, groups);
  const note = mergeNote(merge);
  if (note) notes.push(note);
  const out = [...merged.values()];
  const summaries = [...groups.flatMap((g) => g.summaries), summary];
  log.info('proposal_built', { kind: 'files', root: root.name, files: out.length, newFiles: out.filter((f) => f.isNew).length, change: merge.change, mergedChanges: merge.mergedChanges.length, mergedPending: merge.priorIds.length, notes: notes.length });
  return { proposal: { root: root.name, rootPath: root.path, summary: summaries.join('；'), files: out }, notes, merge };
}

// ---------- propose_pull_request ----------

/**
 * 分支名检查：拒绝以 `-` 或 `refs/` 开头、含空白或控制字符、含 `@{`、单独的 `@`，
 * 再用 `git check-ref-format --branch` 和 `git check-ref-format refs/heads/<name>` 检查
 */
export async function checkBranchName(repo: string, key: string, name: string): Promise<void> {
  const invalid = () => bad(`\`${key}\` is not a valid branch name`);
  if (name.startsWith('-') || name.startsWith('refs/') || name === '@' || /[\s\u0000-\u001F\u007F]/.test(name) || name.includes('@{')) throw invalid();
  try {
    await runGit(repo, ['check-ref-format', '--branch', name]);
    await runGit(repo, ['check-ref-format', `refs/heads/${name}`]);
  } catch (err) {
    if (err instanceof GitError) throw invalid();
    throw err;
  }
}

function timestamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}`;
}

/** 默认分支名：codeinsight/<标题里的英文和数字转成短横线>-<yyyyMMddHHmm>；转出来为空时 codeinsight/pr-<yyyyMMddHHmm> */
export function defaultBranchName(title: string, now: Date = new Date()): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `codeinsight/${slug || 'pr'}-${timestamp(now)}`;
}

/** 取不到默认分支时的提示：工具执行时不联网，让模型直接给出 base */
const NO_DEFAULT_BASE = 'the default branch of origin is not known locally (origin/HEAD is not set, and nothing is fetched while answering); '
  + 'pass `base` with the target branch name, for example "main"';

/**
 * PR 的目标分支：参数里给了就用它，否则用 origin 的默认分支（defaultBranch 不给时只看本地记录，不联网；
 * 保存时传入联网的取法）。名字都经过检查。保存时据此先 fetch 再生成修改
 */
export async function requestedBase(repo: string, input: unknown, defaultBranch: () => Promise<string | undefined> = () => originDefaultBranch(repo)): Promise<string> {
  const base = optString(argsObject(input), 'base') ?? (await defaultBranch());
  if (base === undefined) throw bad(NO_DEFAULT_BASE);
  await checkBranchName(repo, 'base', base);
  return base;
}

async function originCommit(repo: string, base: string): Promise<string> {
  try {
    return await resolveRef(repo, `refs/remotes/origin/${base}`);
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
    throw bad(`origin/${base} is not available locally (nothing is fetched while answering); check \`base\` or ask the user to run git fetch`);
  }
}

/** 路径本身和每一级上级目录 */
function withParents(rel: string): string[] {
  const segs = rel.split('/');
  return segs.map((_, i) => segs.slice(0, i + 1).join('/'));
}

/** 起点提交里的条目：上级必须都是目录；edits 的目标必须是普通文件，create 的目标必须不存在 */
async function commitEntry(repo: string, commit: string, base: string, f: FileArg): Promise<TreeEntry | undefined> {
  const chain = withParents(f.path);
  const entries = await treeEntries(repo, commit, chain);
  for (const p of chain.slice(0, -1)) {
    const e = entries.get(p);
    if (e && e.type !== 'tree') throw new WriteNotAllowedError(`${f.path}: a parent of the path is not a directory on origin/${base}`);
  }
  const entry = entries.get(f.path);
  if (f.create !== undefined && entry) throw bad(`${f.path}: the file already exists on origin/${base}; use edits to change it`);
  if (f.edits && !entry) throw new AskToolFailure('not_found', `${f.path}: no such file on origin/${base}; use create for a new file`);
  if (entry && entry.mode === '120000') throw new WriteNotAllowedError(`${f.path}: the target is a symbolic link`);
  if (entry && (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))) throw new WriteNotAllowedError(`${f.path}: the target is not a regular file`);
  return entry;
}

async function proposeCommitFile(ctx: AskToolContext, commit: string, base: string, f: FileArg, notes: string[]): Promise<ProposedFile> {
  checkWritePath(f.path);
  const entry = await commitEntry(ctx.repo, commit, base, f);
  if (f.create !== undefined) return newFile(f.path, f.create);
  const bytes = await readBlob(ctx.repo, entry!.oid);
  checkEditSize(f.path, bytes.length);
  const baseSha1 = sha1(bytes);
  const content = editedContent(f.path, bytes, f.edits!);
  return { path: f.path, isNew: false, content, baseSha1, ...staleField(ctx, f.path, baseSha1, notes), ...sensitive(f.path) };
}

function parseWorkingTree(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('`fromWorkingTree` must be an object like {"paths": [...]}');
  const paths = (raw as { paths?: unknown }).paths;
  if (paths === undefined || paths === null) return [];
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) throw bad('`fromWorkingTree.paths` must be an array of strings');
  for (const p of paths as string[]) checkWritePath(p);
  return paths as string[];
}

interface PrHead {
  title: string;
  body: string;
  base: string;
  branch: string;
}

/** 标题、正文、目标分支和新分支名（不传时取默认值），都检查过 */
async function prHead(ctx: AskToolContext, args: ToolArgs, now: Date): Promise<PrHead> {
  const title = reqString(args, 'title');
  const body = optString(args, 'body') ?? '';
  const base = await requestedBase(ctx.repo, args);
  const branch = optString(args, 'branch') ?? defaultBranchName(title, now);
  await checkBranchName(ctx.repo, 'branch', branch);
  if (branch === base) throw bad('`branch` must differ from `base`');
  return { title, body, base, branch };
}

/** files 和 fromWorkingTree 恰好给一个；关闭发送源码时只接受 fromWorkingTree */
function prSource(ctx: AskToolContext, args: ToolArgs): 'edits' | 'working_tree' {
  const hasFiles = args.files !== undefined && args.files !== null;
  const hasTree = args.fromWorkingTree !== undefined && args.fromWorkingTree !== null;
  if (hasFiles === hasTree) throw bad('give exactly one of `files` and `fromWorkingTree`');
  if (args.root !== undefined && args.root !== null && args.root !== 'repo') throw new WriteNotAllowedError('a pull request can only change the repository');
  if (hasFiles && !ctx.sendSource) throw bad('source sending is turned off, so a pull request can only use fromWorkingTree');
  return hasFiles ? 'edits' : 'working_tree';
}

/** 同一分支已有的 PR（本次问答里生成的或同会话里还在等确认的）：两次都是 edits 来源且目标分支相同才能并入，否则让模型换分支名 */
function priorPullRequest(drafts: ProposalDrafts, head: PrHead, source: 'edits' | 'working_tree'): PullRequestGroup | undefined {
  const prev = drafts.pullRequest(head.branch);
  if (!prev) return undefined;
  if (prev.source !== 'edits' || source !== 'edits') throw bad(`a pull request on branch ${head.branch} was already proposed in this conversation; use another \`branch\``);
  if (prev.base !== head.base) throw bad(`branch ${head.branch} was already proposed with base ${prev.base}; use the same \`base\` to add to it, or another \`branch\``);
  return prev;
}

/** 前面的 PR 基于较早的 origin/<base> 时，它改的文件在现在的 origin/<base> 上必须没有变（否则合并后会盖掉别人的改动） */
async function checkPriorStart(ctx: AskToolContext, prev: PullRequestGroup, commit: string): Promise<void> {
  if (prev.startCommit === commit) return;
  const files = [...prev.files.values()];
  const entries = await treeEntries(ctx.repo, commit, files.map((f) => f.path));
  for (const f of files) {
    const e = entries.get(f.path);
    const same = f.isNew ? !e : !!e && sha1(await readBlob(ctx.repo, e.oid)) === f.baseSha1;
    if (!same) throw bad(`${f.path} changed on origin/${prev.base} since the pull request on branch ${prev.branch} was proposed; ask the user to apply or dismiss that proposal first, or use another \`branch\``);
  }
}

/** edits 来源的文件：并入同一分支前面的文件，同一文件在前面的内容上继续修改 */
async function pullRequestFiles(ctx: AskToolContext, commit: string, head: PrHead, files: FileArg[], prev: PullRequestGroup | undefined, notes: string[]): Promise<Map<string, ProposedFile>> {
  if (prev) await checkPriorStart(ctx, prev, commit);
  const merged = new Map(prev?.files ?? []);
  for (const f of files) {
    const before = merged.get(pathKey(f.path));
    if (before) checkWritePath(f.path);
    merged.set(pathKey(f.path), before ? onDraft(before, f) : await proposeCommitFile(ctx, commit, head.base, f, notes));
  }
  return merged;
}

/**
 * propose_pull_request：检查参数、分支名和路径。edits 来源按本地已有的 origin/<base> 上的内容预演修改，
 * 同一分支前面生成过的 PR 并入这次；working_tree 来源只检查 paths。不联网、不写对象库。
 */
export async function buildPullRequestProposal(ctx: AskToolContext, input: unknown, opts: { now?: Date } = {}): Promise<BuiltProposal<PullRequestProposal>> {
  const drafts = draftsOf(writeContext(ctx));
  return drafts.serial(() => buildPullRequest(ctx, input, drafts, opts.now ?? new Date()));
}

async function buildPullRequest(ctx: AskToolContext, input: unknown, drafts: ProposalDrafts, now: Date): Promise<BuiltProposal<PullRequestProposal>> {
  const args = argsObject(input);
  checkArgsSize(args);
  const source = prSource(ctx, args);
  const head = await prHead(ctx, args, now);
  loadSessionPending(ctx, drafts);
  const prev = priorPullRequest(drafts, head, source);
  const notes: string[] = [];
  let proposal: PullRequestProposal;
  let files = new Map<string, ProposedFile>();
  if (source === 'working_tree') {
    const paths = parseWorkingTree(args.fromWorkingTree);
    proposal = { ...head, source, startCommit: await resolveRef(ctx.repo, 'HEAD'), paths };
  } else {
    const commit = await originCommit(ctx.repo, head.base);
    files = await pullRequestFiles(ctx, commit, head, parseFiles(args.files), prev, notes);
    proposal = { ...head, source, startCommit: commit, files: [...files.values()] };
  }
  const merge = drafts.commitPullRequest({ branch: head.branch, base: head.base, source, startCommit: proposal.startCommit, files }, prev);
  const note = mergeNote(merge);
  if (note) notes.push(`${note}; the title and body now come from this call`);
  log.info('proposal_built', { kind: 'pull_request', source, base: head.base, branch: head.branch, files: proposal.files?.length ?? proposal.paths?.length ?? 0, change: merge.change, merged: prev !== undefined, notes: notes.length });
  return { proposal, notes, merge };
}
