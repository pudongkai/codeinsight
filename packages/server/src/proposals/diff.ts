import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gitRun, MAX_EDIT_FILE_BYTES, readBlob, resolveWriteTarget, runGit, sha1, treeChanges, treeEntries } from '@codeinsight/core';
import type { FilesProposal, ProposedFile, PullRequestProposal, TreeChange } from '@codeinsight/core';
import { resolveProposalRoot, type WriteEnv } from './apply-files.js';

/** 一个文件的统一 diff */
export interface FileDiff {
  path: string;
  isNew: boolean;
  diff: string;
  /** 磁盘上的内容和生成修改时不同（新文件为期间被创建了） */
  changedSinceProposal?: true;
  /** PR 的 working_tree 来源：文件被删除 */
  deleted?: true;
  /** 原文件超过大小上限，不生成 diff */
  tooLarge?: true;
}

/** 超过这个大小的原文件不读、不生成 diff（能修改的文件不会超过它） */
export const MAX_DIFF_FILE_BYTES = MAX_EDIT_FILE_BYTES;
/** working_tree 来源的 PR 一次 diff 涉及的文件内容合计上限，超过后的文件不生成 diff */
export const MAX_TREE_DIFF_TOTAL_BYTES = 8 * 1024 * 1024;

/** 两段文字的统一 diff：`git diff --no-index` 比两个临时文件（有差异时退出码为 1，按正常处理） */
function gitNoIndexDiff(dir: string): Promise<string> {
  const args = ['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--', 'old', 'new'];
  return runGit(dir, args, { okExitCodes: [1], maxBuffer: 64 * 1024 * 1024, timeoutMs: 30_000 });
}

/** 去掉 git 的文件头（临时文件名），换成按相对路径写的 `---` / `+++` */
function relabel(raw: string, rel: string, isNew: boolean): string {
  const at = raw.search(/^(@@|Binary files)/m);
  if (at < 0) return '';
  return `--- ${isNew ? '/dev/null' : `a/${rel}`}\n+++ b/${rel}\n${raw.slice(at)}`;
}

/** old 为 undefined 时按空文件比较 */
export async function textDiff(rel: string, old: Uint8Array | undefined, next: string, isNew: boolean): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'codeinsight-diff-'));
  try {
    await writeFile(path.join(dir, 'old'), old ?? '');
    await writeFile(path.join(dir, 'new'), next);
    return relabel(await gitNoIndexDiff(dir), rel, isNew);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 文件已有的内容和生成时比较是否变了：已有文件比哈希，新文件看是否已被创建 */
function changed(f: ProposedFile, current: Buffer | undefined): boolean {
  return f.isNew ? current !== undefined : current === undefined || sha1(current) !== f.baseSha1;
}

/** 写文件类：旧内容为磁盘上的当前内容 */
export async function filesDiff(p: FilesProposal, env: WriteEnv): Promise<FileDiff[]> {
  const root = await resolveProposalRoot(p, env);
  const out: FileDiff[] = [];
  for (const f of p.files) {
    const target = await resolveWriteTarget(root.scope, f.path);
    if (target.exists && (await stat(target.abs)).size > MAX_DIFF_FILE_BYTES) {
      // 生成修改时的原文件不超过上限，现在超过说明已经变了
      out.push({ path: f.path, isNew: f.isNew, diff: '', tooLarge: true, changedSinceProposal: true });
      continue;
    }
    const current = target.exists ? await readFile(target.abs) : undefined;
    const diff = await textDiff(f.path, current, f.content, f.isNew);
    out.push({ path: f.path, isNew: f.isNew, diff, ...(changed(f, current) ? { changedSinceProposal: true as const } : {}) });
  }
  return out;
}

/** PR 的 edits 来源：旧内容为起点提交里的内容 */
export async function pullRequestEditsDiff(repo: string, p: PullRequestProposal): Promise<FileDiff[]> {
  const files = p.files ?? [];
  const entries = await treeEntries(repo, p.startCommit, files.map((f) => f.path));
  const out: FileDiff[] = [];
  for (const f of files) {
    const e = entries.get(f.path);
    if (e && !f.isNew && Number(await runGit(repo, ['cat-file', '-s', e.oid])) > MAX_DIFF_FILE_BYTES) {
      out.push({ path: f.path, isNew: f.isNew, diff: '', tooLarge: true });
      continue;
    }
    const old = e && !f.isNew ? await readBlob(repo, e.oid) : undefined;
    out.push({ path: f.path, isNew: f.isNew, diff: await textDiff(f.path, old, f.content, f.isNew) });
  }
  return out;
}

/** tree 里这些路径（按字面匹配）的对象大小；子模块等没有大小的按 0 */
async function blobSizes(repo: string, treeish: string, paths: string[]): Promise<Map<string, number>> {
  if (paths.length === 0) return new Map();
  const out = await runGit(repo, ['--literal-pathspecs', 'ls-tree', '-r', '-l', '-z', '--full-tree', treeish, '--', ...paths]);
  return new Map(out.split('\0').filter((l) => l !== '').map((l) => {
    const tab = l.indexOf('\t');
    const size = Number(l.slice(0, tab).trim().split(/\s+/)[3]);
    return [l.slice(tab + 1), Number.isFinite(size) ? size : 0];
  }));
}

/** 去掉 `diff --git` 和 `index` 行（含对象编号），保留 mode 变化和补丁本身 */
function stripGitHeader(chunk: string): string {
  const at = chunk.search(/^(--- |Binary files)/m);
  const head = (at < 0 ? chunk : chunk.slice(0, at)).split('\n').filter((l) => /^(old|new|deleted file|new file) mode /.test(l));
  return [...head.map((l) => `${l}\n`), at < 0 ? '' : chunk.slice(at)].join('');
}

/**
 * PR 的 working_tree 来源：`git diff <startCommit> <tree>`。旧或新内容超过单个文件上限的、
 * 以及合计超过 MAX_TREE_DIFF_TOTAL_BYTES 之后的文件不生成 diff
 */
export async function pullRequestTreeDiff(repo: string, p: PullRequestProposal): Promise<FileDiff[]> {
  const changes = await treeChanges(await gitRun(repo), p.startCommit, p.tree!);
  const paths = changes.map((c) => c.path);
  const [oldSizes, newSizes] = await Promise.all([blobSizes(repo, p.startCommit, paths), blobSizes(repo, p.tree!, paths)]);
  let total = 0;
  const included = new Set<string>();
  for (const c of changes) {
    const size = (oldSizes.get(c.path) ?? 0) + (newSizes.get(c.path) ?? 0);
    if ((oldSizes.get(c.path) ?? 0) > MAX_DIFF_FILE_BYTES || (newSizes.get(c.path) ?? 0) > MAX_DIFF_FILE_BYTES || total + size > MAX_TREE_DIFF_TOTAL_BYTES) continue;
    total += size;
    included.add(c.path);
  }
  const diffs = await treeFileDiffs(repo, p, changes.filter((c) => included.has(c.path)));
  return changes.map((c) => ({
    path: c.path, isNew: c.status === 'A', ...(c.status === 'D' ? { deleted: true as const } : {}),
    ...(included.has(c.path) ? { diff: diffs.get(c.path) ?? '' } : { diff: '', tooLarge: true as const }),
  }));
}

/**
 * 一次 git diff 得到这些文件的 diff，按输出顺序（和 --raw 相同，按路径排序）对应到路径；
 * 类型变化（T）的文件输出为相邻的删除和新增两段，合成一个
 */
async function treeFileDiffs(repo: string, p: PullRequestProposal, changes: TreeChange[]): Promise<Map<string, string>> {
  if (changes.length === 0) return new Map();
  const args = ['--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-relative', '--ignore-submodules=none'];
  const raw = await runGit(repo, [...args, '--end-of-options', p.startCommit, p.tree!, '--', ...changes.map((c) => c.path)]);
  const chunks = raw.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git '));
  const expected = changes.reduce((n, c) => n + (c.status === 'T' ? 2 : 1), 0);
  if (chunks.length !== expected) throw new Error(`git diff returned ${chunks.length} parts, expected ${expected}`);
  const out = new Map<string, string>();
  let i = 0;
  for (const c of changes) {
    const parts = chunks.slice(i, (i += c.status === 'T' ? 2 : 1));
    out.set(c.path, parts.map(stripGitHeader).join(''));
  }
  return out;
}
