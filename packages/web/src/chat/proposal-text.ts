import type { ProposalView } from '@codeinsight/core/ask/events';
import { ApiError, errorMessage } from '../api/client';
import type { ProposalConflict } from '../api/types';
import { TOOL_ERROR_LABELS } from './tool-labels';

/** 待确认修改相关的错误码（执行结果、接口错误）对应的说明；和工具错误码相同的部分沿用工具的说法 */
const ERROR_LABELS: Record<string, string> = {
  ...TOOL_ERROR_LABELS,
  file_changed_since_proposal: '文件在生成修改后被改过',
  file_exists: '文件已经存在',
  root_changed: '写入位置已变化（切换过仓库，或可写目录被替换）',
  write_failed: '写入失败',
  interrupted: '执行中断',
  not_applicable: '这条修改在保存回答时没能生成，不能写入，请重新提问',
  proposal_applying: '这条修改正在写入（可能是另一个页面发起的），稍后刷新查看结果',
  invalid_status: '这条修改的状态已变化，刷新页面查看',
  proposal_not_found: '这条修改已不存在',
  not_implemented: '暂不支持',
  not_supported: '暂不支持',
  diff_failed: '生成对比失败',
  repo_changed: '当前仓库已切换，请刷新页面',
  repo_header_required: '页面还没读到当前仓库，请刷新页面',
  fetch_failed: '拉取远程分支失败',
  git_failed: 'git 命令失败',
  cancelled: '已取消',
  origin_missing: '仓库没有 origin 远程仓库',
  origin_unknown: '无法确定 origin 对应的 GitHub 仓库',
  push_target_mismatch: 'origin 的推送地址和要建 PR 的 GitHub 仓库不在同一个主机上',
  push_target_unknown: 'origin 推送到另一个仓库，无法确定它属于哪个 GitHub 账号',
  gh_missing: '没有安装 GitHub 命令行工具 gh，或它不在 PATH 里',
  gh_not_authenticated: 'gh 还没有登录，请先运行 gh auth login',
  gh_failed: 'gh 命令失败',
  pr_create_failed: '创建 PR 失败',
  invalid_proposal: '这条修改保存的内容不完整，请重新提问',
  tree_missing: '保存的未提交改动已不在仓库里，请重新提问',
  branch_exists: '远程仓库已有同名分支，且内容不同',
  lfs_not_supported: '有文件用 Git LFS 存储，暂不支持，请手动创建 PR',
  nested_repository: '改动里有嵌套的 git 仓库，不能放进 PR',
  no_changes: '没有未提交的改动可以放进 PR',
};

/** 错误码转成说明；有原文且和说明不同的附在括号里 */
export function proposalErrorText(code: string, message?: string): string {
  const label = ERROR_LABELS[code];
  if (!label) return message || code;
  return message && message !== label ? `${label}（${message}）` : label;
}

/** 接口调用失败的说明：ApiError 的 message 为 `code: 原文` */
export function apiErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return errorMessage(err);
  const prefix = `${err.code}: `;
  return proposalErrorText(err.code, err.message.startsWith(prefix) ? err.message.slice(prefix.length) : undefined);
}

/** 写文件的修改是否写到当前仓库（没有 root 的旧记录也算） */
export function writesRepo(p: ProposalView): boolean {
  return !p.root || p.root === 'repo';
}

/** 写入位置的名称：当前仓库，或可写目录的目录名 */
export function rootLabel(p: ProposalView): string {
  return writesRepo(p) ? '当前仓库' : (p.rootDir ?? p.root ?? '');
}

/** 冲突文件的说明 */
export function conflictText(c: ProposalConflict): string {
  if (c.code === 'file_changed_since_proposal') return '生成修改后文件被改过，仍然写入会覆盖这些改动';
  return c.canForce ? '文件已经存在，仍然写入会覆盖它' : '文件已经存在；仓库以外的目录只能新建文件，不能覆盖';
}
