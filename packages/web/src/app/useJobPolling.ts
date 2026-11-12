import { useState } from 'react';
import { errorMessage } from '../api/client';
import { usePolling } from './usePolling';

const POLL_MS = 1000;

/**
 * 后台任务（审查、概览生成）的读取：open 后立即读一次，status 为 running 时按间隔轮询，结束时调用 onFinished。
 * 读取失败时显示 `<errorPrefix>：<原因>`，按 usePolling 的规则重试（401、404 停止）。
 */
export function useJobPolling<T extends { status: string }>(load: (id: number) => Promise<T>, onFinished: (job: T) => void, errorPrefix: string) {
  // 每次打开都换一个新对象，同一个 id 再打开（或发起时复用）也重新开始轮询
  const [current, setCurrent] = useState<{ id: number }>();
  const [job, setJob] = useState<T>();
  const [error, setError] = useState<string>();
  const id = current?.id;

  usePolling<T>(
    id === undefined
      ? undefined
      : {
          load: () => load(id),
          again: (j) => j.status === 'running',
          onData: (j) => {
            setJob(j);
            setError(undefined);
            if (j.status !== 'running') onFinished(j);
          },
          onError: (err) => setError(`${errorPrefix}：${errorMessage(err)}`),
          intervalMs: POLL_MS,
        },
    [current],
  );

  const open = (jobId: number) => {
    setJob(undefined);
    setError(undefined);
    setCurrent({ id: jobId });
  };
  return { id, job, error, setError, open };
}
