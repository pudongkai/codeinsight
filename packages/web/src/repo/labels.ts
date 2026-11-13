import { ApiError, errorMessage } from '../api/client';
import type { RepoTask } from '../api/types';

const OPEN_ERRORS: Record<string, string> = {
  not_git_repo: '不是 git 仓库',
  path_not_found: '路径不存在',
  not_directory: '不是目录',
  invalid_param: '请输入绝对路径（可以用 ~/ 开头）',
  repo_locked: '这个 serve 锁定了仓库，不能切换',
  switch_in_progress: '另一个切换正在进行，稍后再试',
  repo_busy: '当前仓库有任务在进行：',
};

/** 打开仓库失败时的说明；data_dir_shared 显示服务端的说明 */
export function openErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return `打开失败：${errorMessage(err)}`;
  if (err.code === 'data_dir_shared') return `新仓库会和当前仓库用同一个数据目录：${err.message.replace(/^data_dir_shared: /, '')}`;
  return OPEN_ERRORS[err.code] ?? `打开失败：${err.message}`;
}

/** repo_busy 里的任务，如“正在建索引”“审查 #12 进行中” */
export function taskLabel(t: RepoTask): string {
  switch (t.kind) {
    case 'index':
      return '正在建索引';
    case 'overview':
      return '正在生成概览';
    case 'review':
      return `审查 #${t.id} 进行中`;
    case 'ask':
      return '问答进行中';
  }
}

/** 选择目录失败的说明 */
export function pickErrorText(err: unknown): string {
  if (err instanceof ApiError && err.code === 'picker_busy') return '已经打开了一个选择窗口，请先在那个窗口里选择或取消';
  if (err instanceof ApiError && err.code === 'picker_unavailable') return '这台机器上不能弹出选择窗口，请直接输入路径';
  return `打开选择窗口失败：${errorMessage(err)}`;
}
