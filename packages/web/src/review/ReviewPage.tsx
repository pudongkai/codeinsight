import type { ReviewReport } from '@codeinsight/core/report/types';
import { useEffect, useRef } from 'react';
import type { StatusResponse } from '../api/types';
import { useNav } from '../app/nav';
import { registerPage } from '../bridge';
import type { ReportActions, SymbolTarget } from '../report/actions';
import { ReportView } from '../report/ReportView';
import { ReviewForm } from './ReviewForm';
import { ReviewHistory } from './ReviewHistory';
import { useReviewJob } from './useReviewJob';
import { useSnapshotProbe } from './useSnapshotProbe';

export const SNAPSHOT_GONE_NOTICE = '该报告对应的快照已清理，调用方详情不可用。';

const STEPS: Record<string, string> = { snapshots: '准备两个版本的快照（提取、解析调用关系）', analysis: '分析函数级改动和调用方', similar: '查找重复实现', intent: '检查意图偏离' };

interface Props {
  status: StatusResponse | undefined;
  refreshStatus(): void;
  /** 从报告跳出去后遇到快照已清理时由 App 设置 */
  goneNotice: boolean;
  /** 切换到另一份报告时清除上面的提示 */
  resetGone(): void;
  /** 插件请求审查未提交改动时把审查页切到前面 */
  onHostReview?(): void;
}

/** 插件发起的工作区审查：切到审查页并显示这次审查的进度和报告 */
function useHostReviewRequests(start: (p: { working: true }) => void, onHostReview: (() => void) | undefined) {
  const latest = useRef({ start, onHostReview });
  latest.current = { start, onHostReview };
  useEffect(
    () =>
      registerPage({
        reviewWorking: () => {
          latest.current.onHostReview?.();
          latest.current.start({ working: true });
        },
      }),
    [],
  );
}

function useReportActions(report: ReviewReport | undefined): ReportActions | undefined {
  const nav = useNav();
  if (!report) return undefined;
  const locate = (t: SymbolTarget) => {
    const snapshotId = report[t.side].snapshotId;
    return snapshotId === null ? undefined : { snapshotId, id: t.id, name: t.name, path: t.path, line: t.startLine, removed: t.removed };
  };
  return {
    showSource: (t) => { const s = locate(t); if (s) nav.showSource(s); },
    openGraph: (t) => { const s = locate(t); if (s) nav.openGraph(s, 'review'); },
  };
}

/** 审查页：发起审查、进度、历史记录和报告 */
export function ReviewPage({ status, refreshStatus, goneNotice, resetGone, onHostReview }: Props) {
  const { id, job, error, start, open } = useReviewJob(refreshStatus);
  useHostReviewRequests((p) => void start(p), onHostReview);
  useEffect(resetGone, [id]);
  const report = job?.status === 'done' ? job.report : undefined;
  const probeGone = useSnapshotProbe(report);
  const actions = useReportActions(report);
  return (
    <div className="review-page" data-testid="review-page">
      <div className="review-side">
        <ReviewForm llmConfigured={status?.llmConfigured ?? false} busy={job?.status === 'running'} onSubmit={(p) => void start(p)} />
        <ReviewHistory reviews={status?.reviews ?? []} currentId={id} onOpen={open} />
      </div>
      <div className="review-main">
        {error && <div className="error">{error}</div>}
        {job?.status === 'running' && <div className="panel" data-testid="review-progress">审查 #{job.id} 进行中：{STEPS[job.progress ?? ''] ?? '确定版本和改动文件'}…</div>}
        {job?.status === 'failed' && <div className="error" data-testid="review-failed">审查 #{job.id} 失败：{job.error}</div>}
        {report && <ReportView report={report} actions={actions} notice={probeGone || goneNotice ? SNAPSHOT_GONE_NOTICE : undefined} />}
        {id === undefined && <p className="muted">发起一次审查，或从“最近的审查”里打开。</p>}
      </div>
    </div>
  );
}
