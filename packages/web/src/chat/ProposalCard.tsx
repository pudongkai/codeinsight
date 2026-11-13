import type { ProposalFileView, ProposalView } from '@codeinsight/core/ask/events';
import { DiffView } from './DiffView';
import { PullRequestBody, ProposalRefNote } from './ProposalBody';
import { conflictText, rootLabel, writesRepo } from './proposal-text';
import { ProposalResultLine } from './ProposalResult';
import { useProposal, useProposalDiff } from './useProposal';

/** 可以执行或重试（含执行卡住超时的 applying）：unbuilt 的记录没有可执行的内容 */
const actionable = (p: ProposalView) => (p.status === 'pending' || p.status === 'failed' || p.retryable === true) && !p.unbuilt;

/** checkUnread：修改的内容来自快照之外时（快照里没有该文件）标出“未读取过原文” */
function FileItem({ file, checkUnread }: { file: ProposalFileView; checkUnread: boolean }) {
  return (
    <li data-testid="proposal-file" data-path={file.path}>
      <span className="proposal-tag">{file.isNew ? '新建' : file.deleted ? '删除' : '修改'}</span> <code>{file.path}</code>
      {file.sensitive && <span className="proposal-flag danger" data-testid="file-sensitive">敏感文件，请仔细核对</span>}
      {file.staleSnapshot && <span className="proposal-flag warn-bg" data-testid="file-stale">助手读到的是建索引时的旧内容</span>}
      {checkUnread && !file.isNew && !file.deleted && file.staleSnapshot === undefined && <span className="proposal-flag" data-testid="file-unread">未读取过原文</span>}
    </li>
  );
}

function FileList({ p }: { p: ProposalView }) {
  // unbuilt 的记录只有路径，没有读取情况可标
  const checkUnread = !p.unbuilt && (p.kind === 'files' ? writesRepo(p) : p.source === 'edits');
  return <ul className="proposal-files">{p.files.map((f) => <FileItem key={f.path} file={f} checkUnread={checkUnread} />)}</ul>;
}

function DiffSection({ id, runs }: { id: number; runs: number }) {
  const d = useProposalDiff(id, runs);
  return (
    <div className="proposal-diff">
      <button type="button" className="link" data-testid="proposal-diff-toggle" onClick={() => void d.toggle()}>
        {d.open ? '收起修改内容' : '查看修改内容'}
      </button>
      {d.open && d.loading && <p className="muted">正在读取…</p>}
      {d.open && d.error && <p className="error-inline" data-testid="proposal-diff-error">{d.error}</p>}
      {d.open && d.files?.map((f) => <DiffView key={f.path} file={f} />)}
    </div>
  );
}

type Card = ReturnType<typeof useProposal>;

/** 写文件的冲突文件；全部可以覆盖时提供“仍然写入” */
function Conflicts({ card }: { card: Card }) {
  if (card.conflicts.length === 0) return null;
  const forceable = card.conflicts.every((c) => c.canForce);
  return (
    <div className="proposal-conflicts warn" data-testid="proposal-conflicts">
      <ul>{card.conflicts.map((c) => <li key={c.path} data-testid="conflict-file"><code>{c.path}</code>：{conflictText(c)}</li>)}</ul>
      {forceable
        ? <button type="button" className="small" data-testid="proposal-force" disabled={card.busy !== undefined} onClick={() => void card.apply(true)}>仍然写入</button>
        : <p data-testid="proposal-no-force">有不能覆盖的文件，没有写入任何文件</p>}
    </div>
  );
}

function Actions({ card }: { card: Card }) {
  if (!actionable(card.view) || card.unusable) return null;
  const busy = card.busy !== undefined;
  const label = card.view.kind === 'pull_request' ? '创建 PR' : '写入';
  return (
    <div className="proposal-actions">
      <button type="button" className="primary small" data-testid="proposal-apply" disabled={busy} onClick={() => void card.apply()}>
        {card.view.status === 'failed' || card.view.retryable ? '重试' : label}
      </button>
      <button type="button" className="small" data-testid="proposal-dismiss" disabled={busy} onClick={() => void card.dismiss()}>忽略</button>
    </div>
  );
}

/** 卡片标题和说明：写文件为“修改 N 个文件 · 写入 …”，PR 为“创建 PR：标题 → 目标分支，新分支 …” */
function Heading({ p }: { p: ProposalView }) {
  if (p.kind === 'files') {
    return (
      <>
        <div className="proposal-title">修改 {p.files.length} 个文件 · 写入 {rootLabel(p)}</div>
        {p.summary && <p className="proposal-summary">{p.summary}</p>}
      </>
    );
  }
  return (
    <>
      <div className="proposal-title">创建 PR：{p.title}{p.base ? ` → ${p.base}` : ''}{p.branch ? `，新分支 ${p.branch}` : ''}</div>
      {p.body && <PullRequestBody body={p.body} />}
    </>
  );
}

/** working_tree 来源的 PR：HEAD 上还没推送的提交会一起进 PR */
function UnpushedCommits({ p }: { p: ProposalView }) {
  if (p.kind !== 'pull_request' || !p.unpushedCommits?.length || !actionable(p)) return null;
  return (
    <div className="notice proposal-unpushed" data-testid="proposal-unpushed">
      当前分支上还有这些没推送的提交，会一起进 PR：
      <ul>{p.unpushedCommits.map((c, i) => <li key={i}>{c}</li>)}</ul>
    </div>
  );
}

/** 回答下面的一张待确认修改卡片：标题、文件列表、按需查看 diff、执行 / 忽略和结果 */
export function ProposalCard({ proposal }: { proposal: ProposalView }) {
  const card = useProposal(proposal);
  const p = card.view;
  return (
    <div className="proposal-card" data-testid="proposal-card" data-status={p.status} data-kind={p.kind}>
      <Heading p={p} />
      <FileList p={p} />
      <UnpushedCommits p={p} />
      {actionable(p) && <ProposalRefNote p={p} />}
      {actionable(p) && !card.unusable && <DiffSection id={p.id} runs={card.runs} />}
      <ProposalResultLine p={p} applying={card.busy === 'apply'} />
      {p.unbuilt && <p className="muted" data-testid="proposal-unbuilt">保存时没能生成这条修改，请重新提问</p>}
      {p.kind === 'files' && <Conflicts card={card} />}
      {card.error && <p className="error-inline" data-testid="proposal-error">{card.error}</p>}
      <Actions card={card} />
    </div>
  );
}
