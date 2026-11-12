import { api, ApiError, errorMessage } from '../api/client';
import type { OverviewEstimate, OverviewJob, OverviewParams } from '../api/types';
import { useJobPolling } from '../app/useJobPolling';

/** 发起生成失败的说明；needs_confirm 由调用方处理，不走这里 */
function startError(err: unknown): string {
  if (err instanceof ApiError && err.code === 'overview_running') {
    const pid = typeof err.extra.pid === 'number' ? `（pid ${err.extra.pid}）` : '';
    return `已有概览任务在运行${pid}，请等它结束后再生成。`;
  }
  if (err instanceof ApiError && err.indexNotReady) return '索引还没建好，建好后再生成概览。';
  return `发起生成失败：${errorMessage(err)}`;
}

export type StartResult = { kind: 'started' } | { kind: 'needs_confirm'; estimate: OverviewEstimate } | { kind: 'failed'; error: string };

/** 概览生成任务：发起（处理二次确认和已有任务）、running 时轮询进度，结束时调用 onFinished */
export function useOverviewJob(onFinished: (job: OverviewJob) => void) {
  const { id, job, error, open } = useJobPolling((jobId) => api.overviewJob(jobId), onFinished, '读取生成进度失败');

  const start = async (params: OverviewParams, confirmed: boolean): Promise<StartResult> => {
    try {
      const r = await api.createOverview({ ...params, ...(confirmed ? { confirmed: true } : {}) });
      open(r.id);
      return { kind: 'started' };
    } catch (err) {
      if (err instanceof ApiError && err.code === 'needs_confirm') return { kind: 'needs_confirm', estimate: err.extra.estimate as OverviewEstimate };
      return { kind: 'failed', error: startError(err) };
    }
  };
  // 还没读到进度时算在运行；读取出错（如任务记录已不存在）后不再算，生成按钮可以再点
  const waiting = id !== undefined && job === undefined && error === undefined;
  return { job, error, start, running: job?.status === 'running' || waiting };
}
