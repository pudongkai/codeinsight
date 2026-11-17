import type { ReactNode } from 'react';
import type { EdgeSourceView, SnapshotView, StatusResponse } from '../api/types';
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

/** 品牌标识：内联 SVG，不加载外部资源 */
function Brand() {
  return (
    <span className="brand">
      <svg className="brand-mark" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <rect width="24" height="24" rx="6" fill="currentColor" />
        <circle cx="10.5" cy="10.5" r="4.5" fill="none" stroke="#fff" strokeWidth="2" />
        <path d="M14 14l4.5 4.5" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
      <strong>CodeInsight</strong>
    </span>
  );
}

const LANGUAGE_LABELS: Record<string, string> = { python: 'Python', go: 'Go' };

/** 解析没有成功时的提示：只有部分语言失败时说明是哪些语言，其他语言的邻居图照常可用 */
function resolverWarning(snapshot: SnapshotView): string | undefined {
  if (snapshot.resolverStatus === 'ok') return undefined;
  const failed = snapshot.failedLanguages ?? [];
  if (failed.length === 0) return '调用关系解析失败，邻居图不可用';
  return `${failed.map((l) => LANGUAGE_LABELS[l] ?? l).join('、')} 调用关系解析失败，这部分的邻居图不可用`;
}

/** scip-go 的安装命令，和 core 的 SCIP_GO_INSTALL 一致 */
const SCIP_GO_INSTALL = 'go install github.com/scip-code/scip-go/cmd/scip-go@latest';

/** 名称匹配提示括号里的原因；选项关闭时不提示 */
const NAME_MATCH_REASONS: Partial<Record<NonNullable<EdgeSourceView['reason']>, string>> = {
  not_found: '未找到 scip-go',
  failed: 'scip-go 运行失败',
  no_module: '项目没有 go.mod',
};

/**
 * Go 的调用关系改用名称匹配时的提示（找不到 scip-go、scip-go 运行失败、项目没有 go.mod）；
 * 找不到时附上安装命令，失败时悬停显示原因
 */
function NameMatchHint({ snapshot }: { snapshot: SnapshotView }) {
  const go = snapshot.edgeSources?.go;
  const label = go?.source === 'name_match' && go.reason ? NAME_MATCH_REASONS[go.reason] : undefined;
  if (!go || !label) return null;
  const notFound = go.reason === 'not_found';
  return (
    <span className="warn" data-testid="name-match-hint" title={go.note}>
      Go 调用关系来自名称匹配（{label}），可能不完整
      {notFound && <>，安装：<code data-testid="scip-go-install">{SCIP_GO_INSTALL}</code></>}
    </span>
  );
}

/** 第二行的索引状态：来源、解析失败、建索引进度、代码变化；都没有时不显示 */
function IndexBar({ status, onReindex }: { status: StatusResponse | undefined; onReindex(): void }) {
  if (!status?.repo) return null;
  return (
    <div className="indexbar">
      {status.snapshot && <IndexSource status={status} />}
      {status.snapshot && status.snapshot.resolverStatus !== 'ok' && <span className="warn" data-testid="resolver-warning">{resolverWarning(status.snapshot)}</span>}
      {status.snapshot && <NameMatchHint snapshot={status.snapshot} />}
      <IndexState status={status} />
      <CodeChanged status={status} onReindex={onReindex} />
    </div>
  );
}

/**
 * 顶部状态：第一行是品牌、仓库（可切换）、标签页（children）、当前模型服务、"重新建索引"和设置入口；
 * 第二行是索引来源、代码变化提示和建索引进度。没有仓库时只显示模型服务和设置入口
 */
export function StatusBar({ status, error, onReindex, onRepoSwitched, children }: Props & { children?: ReactNode }) {
  const running = status?.index.job?.status === 'running';
  const openSettings = useOpenSettings();
  const noRepo = status !== undefined && status.repo === null;
  return (
    <div className="statusbar" data-testid="status-bar">
      <div className="topbar">
        <Brand />
        {status?.repo && <RepoName status={status} onSwitched={onRepoSwitched} />}
        {children}
        <span className="topbar-right">
          {status?.llm && <span className="llm-chip" data-testid="llm-label" title="当前的模型服务">{llmLabel(status.llm.provider, status.llm.model)}</span>}
          {!noRepo && <button type="button" className="small" disabled={!status || running} onClick={onReindex} data-testid="reindex">重新建索引</button>}
          {openSettings && <button type="button" className="small settings-button" data-testid="settings-button" onClick={openSettings}>⚙ 设置</button>}
        </span>
      </div>
      <IndexBar status={status} onReindex={onReindex} />
      {error && <div className="indexbar"><span className="error-inline">{error}</span></div>}
    </div>
  );
}
