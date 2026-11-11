import { useState } from 'react';
import { api, errorMessage } from '../api/client';
import type { ReviewParams, ReviewResponse } from '../api/types';
import { usePolling } from '../app/usePolling';

const POLL_MS = 1000;

/** 当前查看的审查：发起或打开历史记录，running 时轮询进度；读取失败时显示错误并继续重试 */
export function useReviewJob(onFinished: () => void) {
  // 每次打开都换一个新对象，重复打开同一个 id 也会重新读取
  const [current, setCurrent] = useState<{ id: number }>();
  const [job, setJob] = useState<ReviewResponse>();
  const [error, setError] = useState<string>();
  const id = current?.id;

  usePolling<ReviewResponse>(
    id === undefined
      ? undefined
      : {
          load: () => api.review(id),
          again: (r) => r.status === 'running',
          onData: (r) => {
            setJob(r);
            setError(undefined);
            if (r.status !== 'running') onFinished();
          },
          onError: (err) => setError(`读取审查结果失败：${errorMessage(err)}`),
          intervalMs: POLL_MS,
        },
    [current],
  );

  const open = (reviewId: number) => {
    setJob(undefined);
    setError(undefined);
    setCurrent({ id: reviewId });
  };
  const start = async (params: ReviewParams) => {
    setError(undefined);
    try {
      const { id: newId } = await api.createReview(params);
      open(newId);
      onFinished();
    } catch (err) {
      setError(`发起审查失败：${errorMessage(err)}`);
    }
  };
  return { id, job, error, start, open };
}
