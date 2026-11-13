import type { ProposalView } from '@codeinsight/core/ask/events';
import { useState } from 'react';

/** 正文超过这么多行时默认只显示前面这些行 */
const PREVIEW_LINES = 6;

/**
 * PR 正文：确认前让用户看到将要公开发布的文字。按纯文本显示，不渲染 Markdown、不生成可点击的链接，
 * 避免正文里的链接文字和实际地址不一致误导用户；较长时默认只显示前几行，可以展开全文。
 */
export function PullRequestBody({ body }: { body: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = body.split('\n');
  const long = lines.length > PREVIEW_LINES;
  const shown = long && !expanded ? `${lines.slice(0, PREVIEW_LINES).join('\n')}\n…` : body;
  return (
    <div className="proposal-body" data-testid="proposal-body">
      <div className="proposal-tag">PR 正文（会公开发布）</div>
      <pre data-testid="proposal-body-text">{shown}</pre>
      {long && (
        <button type="button" className="link" data-testid="proposal-body-toggle" onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起正文' : `展开全文（共 ${lines.length} 行）`}
        </button>
      )}
    </div>
  );
}

/** working_tree 来源的 PR：未提交的改动在执行前存放在一个 git 引用里，说明它的位置和影响 */
export function ProposalRefNote({ p }: { p: ProposalView }) {
  if (p.kind !== 'pull_request' || p.source !== 'working_tree') return null;
  return (
    <p className="muted proposal-ref-note" data-testid="proposal-ref-note">
      改动临时保存在 git 引用 refs/codeinsight/proposals/… 中，执行或忽略后删除；git push --mirror 会把它一起推送。
    </p>
  );
}
