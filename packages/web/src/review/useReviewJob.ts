import { api, errorMessage } from '../api/client';
import type { ReviewParams } from '../api/types';
import { useJobPolling } from '../app/useJobPolling';

/** 当前查看的审查：发起或打开历史记录，running 时轮询进度；读取失败时显示错误并继续重试 */
export function useReviewJob(onFinished: () => void) {
  const { id, job, error, setError, open } = useJobPolling((reviewId) => api.review(reviewId), () => onFinished(), '读取审查结果失败');
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
