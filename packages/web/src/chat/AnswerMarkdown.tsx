import { parseInternalLink } from '@codeinsight/core/ask/links';
import type { SymbolRef } from '@codeinsight/core/report/types';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import { api, ApiError } from '../api/client';
import type { CurrentLinks } from '../app/useCurrentLinks';

export type AnswerLinks = Pick<CurrentLinks, 'openSymbol' | 'openSourceAt'>;

interface LinkContext {
  links: AnswerLinks;
  refs: Record<string, SymbolRef>;
  /** 正在接收的回答还没有 refs，符号链接先按可点击显示 */
  answering: boolean;
  snapshotId: number | undefined;
}

interface Props extends LinkContext {
  text: string;
}

/** 只放行 `sym:` 和 `src:` 两种内部链接，其他地址一律清空（页面里不出现可点击的外部链接） */
export function answerUrlTransform(url: string): string {
  return parseInternalLink(url) ? url : '';
}

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** 在 urlTransform 清空地址之前，把链接原地址记到 data-address，供“文字加地址”显示 */
function keepLinkAddress() {
  const walk = (n: HastNode): void => {
    if (n.type === 'element' && n.tagName === 'a' && n.properties) n.properties.dataAddress = n.properties.href;
    n.children?.forEach(walk);
  };
  return walk;
}

function plainText(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(plainText).join('');
  return '';
}

/** 不在 refs 里的符号到当前快照查一次；查不到（404）时返回 false */
function useSymbolExists(snapshotId: number | undefined, id: string): boolean | undefined {
  const [exists, setExists] = useState<boolean>();
  useEffect(() => {
    if (snapshotId === undefined) return;
    let cancelled = false;
    api.symbol(snapshotId, id).then(
      () => !cancelled && setExists(true),
      (err: unknown) => !cancelled && setExists(!(err instanceof ApiError && err.status === 404)),
    );
    return () => {
      cancelled = true;
    };
  }, [snapshotId, id]);
  return exists;
}

const LinkContextValue = createContext<LinkContext | undefined>(undefined);

function SymLink({ id, children }: { id: string; children: ReactNode }) {
  const ctx = useContext(LinkContextValue)!;
  const known = ctx.answering || id in ctx.refs;
  const exists = useSymbolExists(known ? undefined : ctx.snapshotId, id);
  if (exists === false) return <span data-testid="plain-link">{children}</span>;
  const qualifiedName = ctx.refs[id]?.qualifiedName ?? (plainText(children) || id);
  return (
    <button type="button" className="link" data-testid="sym-link" data-id={id} onClick={() => ctx.links.openSymbol({ id, qualifiedName })}>{children}</button>
  );
}

/** src: 链接：没有行号时打开到第 1 行 */
function SrcLink({ path, start, end, children }: { path: string; start?: number; end?: number; children: ReactNode }) {
  const ctx = useContext(LinkContextValue)!;
  return <button type="button" className="link" data-testid="src-link" onClick={() => ctx.links.openSourceAt(path, start ?? 1, end)}>{children}</button>;
}

/** sym: 打开符号，src: 打开源码位置，其他链接显示为文字加地址、不可点击 */
function LinkView({ href, address, children }: { href?: string; address?: string; children: ReactNode }) {
  const link = href ? parseInternalLink(href) : undefined;
  if (link?.kind === 'sym') return <SymLink id={link.id}>{children}</SymLink>;
  if (link?.kind === 'src') return <SrcLink path={link.path} start={link.start} end={link.end}>{children}</SrcLink>;
  const showAddress = address && address !== plainText(children);
  return <span data-testid="plain-link">{children}{showAddress ? `（${address}）` : ''}</span>;
}

// 组件在模块级定义、身份不变，流式追加文字时已渲染的链接不会重新挂载
const COMPONENTS: Components = {
  a: ({ href, children, ...rest }) => (
    <LinkView href={href} address={(rest as Record<string, unknown>)['data-address'] as string | undefined}>{children}</LinkView>
  ),
  // 图片地址同样不放行，只显示替代文字
  img: ({ alt }) => <span>{alt}</span>,
};

const REHYPE_PLUGINS = [keepLinkAddress];

/** 回答的 Markdown：不渲染 HTML（按文字显示），内部链接渲染为按钮 */
export function AnswerMarkdown({ text, links, refs, answering, snapshotId }: Props) {
  return (
    <LinkContextValue.Provider value={{ links, refs, answering, snapshotId }}>
      <div className="answer-text" data-testid="answer-text">
        <Markdown urlTransform={answerUrlTransform} rehypePlugins={REHYPE_PLUGINS} components={COMPONENTS}>{text}</Markdown>
      </div>
    </LinkContextValue.Provider>
  );
}
