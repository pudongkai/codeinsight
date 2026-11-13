import type { StatusResponse } from '../api/types';
import { basedOn, formatShortTime } from '../format';
import { RepoSwitcher } from '../repo/RepoSwitcher';
import { useOpenSettings } from '../settings/context';
import { llmLabel } from '../settings/model-label';

interface Props {
  status: StatusResponse | undefined;
  error?: string;
  onReindex(): void;
  /** 在顶栏切换了仓库 */
  onRepoSwitched(): void;
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

/** 当前索引的来源：建索引时间、所基于的提交、是否含未提交改动，最近一次建索引复用了已有索引时注明 */
function IndexSource({ status }: { status: StatusResponse }) {
  const snap = status.snapshot!;
  const job = status.index.job;
  const reused = job?.status === 'done' && job.cached === true && job.snapshotId === snap.id;
  return (
    <span className="index-source">
      <span data-testid="index-time">索引建于 {formatShortTime(snap.createdAt)}</span>
      {' · '}
      <span data-testid="index-commit">{basedOn(snap.commitSha, snap.dirty)}</span>
      {reused && <span className="tag" data-testid="index-reused">复用已有索引</span>}
    </span>
  );
}

/** 代码比索引新时的提示：开了自动更新且没失败过时说明稍后更新，否则提供“更新索引” */
function CodeChanged({ status, onReindex }: { status: StatusResponse; onReindex(): void }) {
  const { codeChanged, autoReindex, autoReindexFailed } = status.changes;
  if (!codeChanged || status.index.job?.status === 'running') return null;
  if (autoReindex && !autoReindexFailed) return <span className="warn" data-testid="code-changed">代码已变化，稍后自动更新索引</span>;
  return (
    <span className="warn" data-testid="code-changed">
      {autoReindexFailed ? '代码已变化，自动更新索引失败，不会再自动重试' : '代码已变化，索引不是最新的'}{' '}
      <button type="button" className="small" data-testid="update-index" onClick={onReindex}>更新索引</button>
    </span>
  );
}

/** 仓库名：serve 锁定了仓库时只做显示，否则带切换下拉 */
function RepoName({ status, onSwitched }: { status: StatusResponse; onSwitched(): void }) {
  if (status.repoLocked) return <code className="repo" data-testid="repo-name">{status.repo}</code>;
  return <RepoSwitcher status={status} onSwitched={onSwitched} />;
}

/** 顶部状态：仓库（可切换）、索引来源、代码变化提示、建索引进度、当前模型服务、"重新建索引"和设置入口；没有仓库时只显示模型服务和设置入口 */
export function StatusBar({ status, error, onReindex, onRepoSwitched }: Props) {
  const running = status?.index.job?.status === 'running';
  const openSettings = useOpenSettings();
  const noRepo = status !== undefined && status.repo === null;
  return (
    <div className="statusbar" data-testid="status-bar">
      <strong>CodeInsight</strong>
      {status?.repo && <RepoName status={status} onSwitched={onRepoSwitched} />}
      {status?.snapshot && <IndexSource status={status} />}
      {status?.snapshot && status.snapshot.resolverStatus !== 'ok' && <span className="warn">调用关系解析失败，邻居图不可用</span>}
      {status?.repo && <IndexState status={status} />}
      {status?.repo && <CodeChanged status={status} onReindex={onReindex} />}
      {status?.llm && <span className="muted" data-testid="llm-label" title="当前的模型服务">{llmLabel(status.llm.provider, status.llm.model)}</span>}
      {!noRepo && <button type="button" className="small" disabled={!status || running} onClick={onReindex} data-testid="reindex">重新建索引</button>}
      {error && <span className="error-inline">{error}</span>}
      {openSettings && <button type="button" className="small settings-button" data-testid="settings-button" onClick={openSettings}>⚙ 设置</button>}
    </div>
  );
}
