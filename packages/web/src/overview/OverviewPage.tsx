import { useState } from 'react';
import { api } from '../api/client';
import type { OverviewJob, StatusResponse } from '../api/types';
import { useCurrentLinks } from '../app/useCurrentLinks';
import { useApi } from '../browse/useApi';
import { WarningsPanel } from '../report/WarningsPanel';
import { GenerateDialog } from './GenerateDialog';
import { STEP_LABELS } from './labels';
import { OverviewBody } from './OverviewBody';
import { SystemCard } from './SystemCard';
import { useOverviewJob } from './useOverviewJob';

interface Props {
  status: StatusResponse | undefined;
  refreshStatus(): void;
}

function progressText(job: OverviewJob | undefined): string {
  const p = job?.progress;
  if (!p) return '准备中';
  const count = p.total !== undefined ? `（${p.done ?? 0} / ${p.total}）` : '';
  return `${STEP_LABELS[p.step] ?? p.step}${count}`;
}

/** 生成进度和失败原因 */
function JobState({ job, error }: { job: ReturnType<typeof useOverviewJob>; error?: string }) {
  return (
    <>
      {job.running && <div className="panel" data-testid="overview-progress">正在生成概览：{progressText(job.job)}…</div>}
      {job.job?.status === 'failed' && <div className="error" data-testid="overview-failed">概览生成失败：{job.job.error}</div>}
      {(job.error ?? error) && <div className="error">{job.error ?? error}</div>}
    </>
  );
}

/** 还没有概览时的说明和生成按钮 */
function EmptyState({ ready, busy, onGenerate }: { ready: boolean; busy: boolean; onGenerate(): void }) {
  return (
    <section className="panel" data-testid="overview-empty">
      <h3>系统概览</h3>
      <p className="muted">{ready ? '还没有生成概览。生成后可以看到模块划分、模块依赖、外部依赖、功能清单和边界问题。' : '索引建好后可以生成概览。'}</p>
      <button type="button" className="primary" data-testid="overview-generate" disabled={!ready || busy} onClick={onGenerate}>生成概览</button>
    </section>
  );
}

/** 当前概览（或 viewId 指定的记录）；生成结束、换了当前概览或快照时重新读取 */
function useOverviewData(status: StatusResponse | undefined, viewId: number | undefined, round: number) {
  const has = viewId !== undefined || Boolean(status?.overview);
  return useApi(has ? () => api.overview(viewId) : undefined, [viewId, status?.overview?.id, status?.snapshot?.id, round]);
}

/** 概览页：系统简介、生成弹窗和进度、模块列表与模块图、功能、外部依赖、边界问题 */
export function OverviewPage({ status, refreshStatus }: Props) {
  const [viewId, setViewId] = useState<number>();
  const [round, setRound] = useState(0);
  const [dialog, setDialog] = useState(false);
  const job = useOverviewJob((j) => {
    refreshStatus();
    if (j.status === 'done') {
      setViewId(undefined);
      setRound((n) => n + 1);
    }
  });
  const ov = useOverviewData(status, viewId, round);
  const links = useCurrentLinks(status?.snapshot?.id);
  const data = ov.data;
  const openDialog = () => setDialog(true);
  return (
    <div className="overview-page" data-testid="overview-page">
      <div className="overview-head">
        {data ? (
          <SystemCard data={data} viewingOther={viewId !== undefined} busy={job.running} onGenerate={openDialog} onView={setViewId} />
        ) : (
          !ov.loading && <EmptyState ready={Boolean(status?.snapshot)} busy={job.running} onGenerate={openDialog} />
        )}
        <JobState job={job} error={ov.error && `读取概览失败：${ov.error}`} />
        {links.notice && <div className="notice" data-testid="link-notice">{links.notice}</div>}
        {data && <WarningsPanel warnings={data.overview.warnings} />}
      </div>
      {data && <OverviewBody key={data.id} report={data.overview} links={links} />}
      {dialog && status && <GenerateDialog status={status} onStart={job.start} onClose={() => setDialog(false)} />}
    </div>
  );
}
