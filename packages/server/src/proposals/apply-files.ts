import { readFile, stat } from 'node:fs/promises';
import {
  knownFailure, ProposalError, realPathOr, resolveWriteRoot, resolveWriteTarget, sha1, writeFileAtomic, writeScopeFor, WriteNotAllowedError,
} from '@codeinsight/core';
import type { FilesProposal, ProposedFile, WriteScope } from '@codeinsight/core';

/** 执行时的环境：当前仓库、数据目录、启动时的可写目录 */
export interface WriteEnv {
  repo: string;
  dataDir: string;
  writableDirs: readonly string[];
}

/** 执行失败（没写或写了一部分）：code 和原因记进结果 */
export class ApplyError extends ProposalError {}

export type ConflictCode = 'file_changed_since_proposal' | 'file_exists';

/** 写之前发现的冲突：用户确认后可以带 force 重发（canForce 为 false 的不行） */
export interface FileConflict {
  path: string;
  code: ConflictCode;
  canForce: boolean;
}

/** 一个文件怎么写：overwrite 为替换已有文件（保留它的权限），否则排他创建；done 为磁盘上已经是修改后的内容（上次部分写入），不再写 */
interface FilePlan {
  file: ProposedFile;
  abs: string;
  overwrite: boolean;
  mode?: number;
  done?: true;
}

export interface ResolvedRoot {
  scope: WriteScope;
  repo: boolean;
}

/** 写入根目录必须仍是生成修改时的那个：仓库切换过、可写目录变了或被删掉都直接失败 */
export async function resolveProposalRoot(p: FilesProposal, env: WriteEnv): Promise<ResolvedRoot> {
  const root = resolveWriteRoot(p.root, env.repo, env.writableDirs);
  if ((await realPathOr(root.path)) !== (await realPathOr(p.rootPath))) {
    throw new ApplyError('root_changed', root.repo ? 'the repository has been switched since the change was proposed' : `the writable directory ${p.root} is no longer the one the change was proposed for`);
  }
  return { scope: writeScopeFor(root, env.dataDir), repo: root.repo };
}

async function fileMode(abs: string): Promise<number> {
  return (await stat(abs)).mode & 0o7777;
}

/** 已有文件：磁盘内容和生成时不同（或已被删除）时是冲突，force 时照写（只限仓库内） */
async function planExisting(root: ResolvedRoot, f: ProposedFile, abs: string, exists: boolean, force: boolean): Promise<FilePlan | FileConflict> {
  if (!root.repo) throw new ApplyError('write_not_allowed', `${f.path}: files outside the repository cannot be overwritten`);
  const changed = !exists || sha1(await readFile(abs)) !== f.baseSha1;
  if (changed && !force) return { path: f.path, code: 'file_changed_since_proposal', canForce: true };
  return exists ? { file: f, abs, overwrite: true, mode: await fileMode(abs) } : { file: f, abs, overwrite: false };
}

/** 新文件：目标已存在时是冲突，仓库内可以 force 覆盖，仓库以外不行 */
async function planNew(root: ResolvedRoot, f: ProposedFile, abs: string, exists: boolean, force: boolean): Promise<FilePlan | FileConflict> {
  if (!exists) return { file: f, abs, overwrite: false };
  if (!root.repo || !force) return { path: f.path, code: 'file_exists', canForce: root.repo };
  return { file: f, abs, overwrite: true, mode: await fileMode(abs) };
}

/** 磁盘上已经是修改后的内容：先比大小，相同再比哈希 */
async function alreadyWritten(abs: string, content: string): Promise<boolean> {
  if ((await stat(abs)).size !== Buffer.byteLength(content)) return false;
  return sha1(await readFile(abs)) === sha1(content);
}

/** 再检查每个文件的路径，算出怎么写；有冲突时返回冲突列表，什么都不写 */
export async function planFiles(root: ResolvedRoot, files: readonly ProposedFile[], force: boolean): Promise<{ plans: FilePlan[]; conflicts: FileConflict[] }> {
  const plans: FilePlan[] = [];
  const conflicts: FileConflict[] = [];
  for (const f of files) {
    const target = await resolveWriteTarget(root.scope, f.path);
    if (target.exists && (await alreadyWritten(target.abs, f.content))) {
      plans.push({ file: f, abs: target.abs, overwrite: false, done: true });
      continue;
    }
    const r = f.isNew ? await planNew(root, f, target.abs, target.exists, force) : await planExisting(root, f, target.abs, target.exists, force);
    if ('code' in r) conflicts.push(r);
    else plans.push(r);
  }
  return { plans, conflicts };
}

/**
 * 写一个文件：缺的上级目录在根目录内逐级创建并检查；临时文件写好后、改名或 link 之前再检查一次路径
 * （父目录此时已建好，按真实路径检查）
 */
async function writePlan(scope: WriteScope, plan: FilePlan): Promise<void> {
  if (plan.done) return;
  const recheck = async () => {
    const t = await resolveWriteTarget(scope, plan.file.path);
    if (t.abs !== plan.abs) throw new WriteNotAllowedError(`${plan.file.path}: the target location changed`);
  };
  const opts = { ...(plan.mode !== undefined ? { mode: plan.mode } : {}), exclusive: !plan.overwrite, beforeCommit: recheck, root: await realPathOr(scope.root) };
  try {
    await writeFileAtomic(plan.abs, plan.file.content, opts);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new ApplyError('file_exists', `${plan.file.path}: the file was created by someone else before it could be written`);
    throw err;
  }
}

/** 按顺序写；某个文件失败时停下，返回已写入的文件和失败原因 */
export async function writePlans(scope: WriteScope, plans: readonly FilePlan[]): Promise<{ written: string[]; error?: ApplyError }> {
  const written: string[] = [];
  for (const p of plans) {
    try {
      await writePlan(scope, p);
    } catch (err) {
      return { written, error: toApplyError(err) };
    }
    written.push(p.file.path);
  }
  return { written };
}

/** 其他异常转成 ApplyError；原因不含绝对路径 */
export function toApplyError(err: unknown): ApplyError {
  if (err instanceof ApplyError) return err;
  const known = knownFailure(err, 'writing');
  if (known) return new ApplyError(known.code, known.message);
  const code = (err as NodeJS.ErrnoException).code;
  return new ApplyError('write_failed', code ? `writing failed (${code})` : 'writing failed');
}
