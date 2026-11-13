import { useState } from 'react';
import { ApiError, api } from '../api/client';
import type { OpenRepoResult, RepoTask } from '../api/types';
import { openErrorText } from './labels';

export interface OpenRepoError {
  text: string;
  /** 打开的路径，“取消并切换”时再用 */
  path: string;
  /** repo_busy 时在跑的任务 */
  tasks?: RepoTask[];
}

/** 打开或切换仓库（POST /api/repo）：成功时调用 onOpened，失败时给出说明；repo_busy 时带上任务列表 */
export function useOpenRepo(onOpened: (r: OpenRepoResult) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<OpenRepoError>();
  const open = async (path: string, cancelRunning = false) => {
    const p = path.trim();
    if (!p) return;
    setBusy(true);
    setError(undefined);
    try {
      onOpened(await api.openRepo(p, cancelRunning));
    } catch (err) {
      const tasks = err instanceof ApiError && err.code === 'repo_busy' ? (err.extra.tasks as RepoTask[] | undefined) : undefined;
      setError({ text: openErrorText(err), path: p, tasks });
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, open };
}

export type RepoOpener = ReturnType<typeof useOpenRepo>;
