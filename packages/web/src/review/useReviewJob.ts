import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api/client';
import type { ReviewParams, ReviewResponse } from '../api/types';

const POLL_MS = 1000;

/** 当前查看的审查：发起或打开历史记录，running 时轮询进度 */
export function useReviewJob(onFinished: () => void) {
  const [id, setId] = useState<number>();
  const [job, setJob] = useState<ReviewResponse>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (id === undefined) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const r = await api.review(id);
        if (cancelled) return;
        setJob(r);
        setError(undefined);
        if (r.status === 'running') timer = window.setTimeout(poll, POLL_MS);
        else onFinished();
      } catch (err) {
        if (!cancelled) setError(`读取审查结果失败：${errorMessage(err)}`);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // onFinished 只用于通知刷新历史列表
  }, [id]);

  const start = async (params: ReviewParams) => {
    setError(undefined);
    try {
      const { id: newId } = await api.createReview(params);
      setJob(undefined);
      setId(newId);
      onFinished();
    } catch (err) {
      setError(`发起审查失败：${errorMessage(err)}`);
    }
  };
  const open = (reviewId: number) => {
    setJob(undefined);
    setId(reviewId);
  };
  return { id, job, error, start, open };
}
