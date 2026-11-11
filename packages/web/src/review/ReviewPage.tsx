import type { ReviewReport } from '@codeinsight/core/report/types';
import { useEffect, useRef, useState } from 'react';
import type { ReviewParams, StatusResponse } from '../api/types';
import { useNav } from '../app/nav';
import { hostBridge, registerPage } from '../bridge';
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

/** 表单交给插件后最多等这么久回调；超时后放开表单，避免插件没响应时一直不能再提交 */
export const HOST_REVIEW_TIMEOUT_MS = 10_000;
export const HOST_TIMEOUT_NOTICE = 'IDE 没有响应保存请求，请重新发起审查。';

/**
 * 工作区审查要让 IDE 先保存编辑器：有 JS 桥时页面表单不直接发起，而是调用插件的 reviewWorking，
 * 插件保存后回调 codeinsightPage.reviewWorking，由它带上表单参数发起审查。
 * 等待回调期间 waiting 为 true，表单不可再提交，避免连点发起两次、第二次丢掉表单参数；超时后放开并给出提示。
 * codeinsightPage.reviewWorking 自己总是直接发起审查，不会再回到插件，避免来回调用。
 */
function useWorkingReview(start: (p: ReviewParams) => void, onHostReview: (() => void) | undefined) {
  const latest = useRef({ start, onHostReview });
  latest.current = { start, onHostReview };
  // 表单交给插件后等待回调时的参数；插件自己的"审查未提交改动"动作没有表单参数
  const pending = useRef<ReviewParams | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const [waiting, setWaiting] = useState(false);
  const [notice, setNotice] = useState<string>();
  const settle = (timedOut: boolean) => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    pending.current = undefined;
    setWaiting(false);
    setNotice(timedOut ? HOST_TIMEOUT_NOTICE : undefined);
  };
  const settleRef = useRef(settle);
  settleRef.current = settle;
  useEffect(() => {
    const unregister = registerPage({
      reviewWorking: () => {
        const params = pending.current ?? { working: true };
        settleRef.current(false);
        latest.current.onHostReview?.();
        latest.current.start(params);
      },
    });
    return () => {
      unregister();
      window.clearTimeout(timer.current);
    };
  }, []);
  const submit = (params: ReviewParams) => {
    const host = hostBridge();
    if (!params.working || typeof host?.reviewWorking !== 'function') return start(params);
    if (pending.current) return;
    pending.current = params;
    setWaiting(true);
    setNotice(undefined);
    timer.current = window.setTimeout(() => settleRef.current(true), HOST_REVIEW_TIMEOUT_MS);
    host.reviewWorking();
  };
  return { submit, waiting, notice };
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
  const host = useWorkingReview((p) => void start(p), onHostReview);
  useEffect(resetGone, [id]);
  const report = job?.status === 'done' ? job.report : undefined;
  const probeGone = useSnapshotProbe(report);
  const actions = useReportActions(report);
  return (
    <div className="review-page" data-testid="review-page">
      <div className="review-side">
        <ReviewForm llmConfigured={status?.llmConfigured ?? false} busy={job?.status === 'running' || host.waiting} busyText={host.waiting ? '等待 IDE 保存…' : undefined} onSubmit={host.submit} />
        <ReviewHistory reviews={status?.reviews ?? []} currentId={id} onOpen={open} />
      </div>
      <div className="review-main">
        {error && <div className="error">{error}</div>}
        {host.notice && <div className="error" data-testid="host-timeout">{host.notice}</div>}
        {job?.status === 'running' && <div className="panel" data-testid="review-progress">审查 #{job.id} 进行中：{STEPS[job.progress ?? ''] ?? '确定版本和改动文件'}…</div>}
        {job?.status === 'failed' && <div className="error" data-testid="review-failed">审查 #{job.id} 失败：{job.error}</div>}
        {report && <ReportView report={report} actions={actions} notice={probeGone || goneNotice ? SNAPSHOT_GONE_NOTICE : undefined} />}
        {id === undefined && <p className="muted">发起一次审查，或从“最近的审查”里打开。</p>}
      </div>
    </div>
  );
}
