import type { ProposalView } from '@codeinsight/core/ask/events';
import { useRef, useState } from 'react';
import { proposalErrorText } from './proposal-text';

function WrittenList({ files }: { files: string[] | undefined }) {
  if (!files || files.length === 0) return null;
  return <ul className="proposal-written">{files.map((f) => <li key={f}><code>{f}</code></li>)}</ul>;
}

/** 选中元素里的文字 */
function selectText(el: HTMLElement | null): void {
  const sel = window.getSelection();
  if (!el || !sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** PR 链接：新窗口打开；“复制链接”在剪贴板不可用时选中链接文字，方便手动复制（插件里外部链接可能打不开） */
function PullRequestLink({ url }: { url: string }) {
  const link = useRef<HTMLAnchorElement>(null);
  const [copied, setCopied] = useState<'ok' | 'failed'>();
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(url);
      setCopied('ok');
    } catch {
      selectText(link.current);
      setCopied('failed');
    }
  };
  return (
    <div className="proposal-pr-link">
      <a ref={link} href={url} target="_blank" rel="noopener noreferrer" data-testid="proposal-pr-url">{url}</a>
      <button type="button" className="small" data-testid="proposal-copy" onClick={() => void copy()}>复制链接</button>
      {copied === 'ok' && <span className="ok-inline" data-testid="proposal-copied">已复制</span>}
      {copied === 'failed' && <span className="warn" data-testid="proposal-copy-failed">无法写入剪贴板，链接已选中，请手动复制</span>}
    </div>
  );
}

function Failure({ p }: { p: ProposalView }) {
  const err = p.result?.error;
  const written = p.result?.written ?? [];
  return (
    <div data-testid="proposal-result" className="error-inline">
      失败：{err ? proposalErrorText(err.code, err.message) : '未知原因'}
      {written.length > 0 && <>，失败前已写入：<WrittenList files={written} /></>}
      {p.kind === 'pull_request' && p.pushed && <p className="muted" data-testid="proposal-pushed">分支已推送，重试会继续创建 PR</p>}
    </div>
  );
}

/** 执行结果：执行中、已写入（列出文件）/ 已创建 PR（链接）、失败原因、已忽略 */
export function ProposalResultLine({ p, applying }: { p: ProposalView; applying: boolean }) {
  const pr = p.kind === 'pull_request';
  if (!applying && p.retryable) return <p className="warn" data-testid="proposal-result">执行很久没有进展，可能已中断，可以重试或忽略</p>;
  if (applying || p.status === 'applying') return <p className="muted" data-testid="proposal-result">{pr ? '正在创建 PR…' : '正在写入…'}</p>;
  if (p.status === 'dismissed') return <p className="muted" data-testid="proposal-result">{p.result?.mergedInto !== undefined ? '已并入后面的修改' : '已忽略'}</p>;
  if (p.status === 'failed') return <Failure p={p} />;
  if (p.status !== 'applied') return null;
  if (!pr) return <div data-testid="proposal-result" className="ok-inline">已写入<WrittenList files={p.result?.written} /></div>;
  return (
    <div data-testid="proposal-result" className="ok-inline">
      已创建 PR{p.result?.url && <PullRequestLink url={p.result.url} />}
    </div>
  );
}
