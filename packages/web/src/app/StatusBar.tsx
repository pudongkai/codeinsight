import type { StatusResponse } from '../api/types';
import { formatTime } from '../format';

interface Props {
  status: StatusResponse | undefined;
  error?: string;
  onReindex(): void;
}

function IndexState({ status }: { status: StatusResponse }) {
  const job = status.index.job;
  if (job?.status === 'running') {
    const secs = Math.round((Date.now() - job.startedAt) / 1000);
    return <span className="indexing" data-testid="index-progress">正在{status.snapshot ? '重新' : ''}建索引…（已用 {secs}s）</span>;
  }
  if (!status.snapshot && job?.status === 'failed') return <span className="error-inline">建索引失败：{job.error}</span>;
  if (!status.snapshot) return <span className="indexing" data-testid="index-progress">等待建索引…</span>;
  return null;
}

/** 顶部状态：仓库、索引时间、建索引进度和"重新建索引" */
export function StatusBar({ status, error, onReindex }: Props) {
  const running = status?.index.job?.status === 'running';
  return (
    <div className="statusbar" data-testid="status-bar">
      <strong>CodeInsight</strong>
      {status && <code className="repo">{status.repo}</code>}
      {status?.snapshot && <span data-testid="index-time">索引建于 {formatTime(status.snapshot.createdAt)}</span>}
      {status?.snapshot && status.snapshot.resolverStatus !== 'ok' && <span className="warn">调用关系解析失败，邻居图不可用</span>}
      {status && <IndexState status={status} />}
      <button type="button" className="small" disabled={!status || running} onClick={onReindex} data-testid="reindex">重新建索引</button>
      {error && <span className="error-inline">{error}</span>}
    </div>
  );
}
