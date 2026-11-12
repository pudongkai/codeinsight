/**
 * 问答回答里的内部链接：`sym:<symbolId>` 打开符号，`src:<path>#L<start>-L<end>` 打开源码位置。
 * 纯函数，server 校验和 web 渲染共用；web 通过 `@codeinsight/core/ask/links` 引用。
 */
import { isSafeRelativePath } from '../util/relative-path.js';

export type InternalLink =
  | { kind: 'sym'; id: string }
  | { kind: 'src'; path: string; start?: number; end?: number };

/** 符号 id 只含这些字符（sha1 前缀等），其他内容不当成链接 */
const SYMBOL_ID = /^[\w.:-]{1,128}$/;
const LINE_FRAGMENT = /^L(\d+)(?:-L?(\d+))?$/;

function decode(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

function parseSrc(rest: string): InternalLink | undefined {
  const hash = rest.indexOf('#');
  const path = decode(hash < 0 ? rest : rest.slice(0, hash));
  if (path === undefined || !isSafeRelativePath(path)) return undefined;
  if (hash < 0) return { kind: 'src', path };
  const m = LINE_FRAGMENT.exec(rest.slice(hash + 1));
  if (!m) return { kind: 'src', path };
  const start = Number(m[1]);
  const end = m[2] === undefined ? start : Number(m[2]);
  if (start < 1 || end < start) return { kind: 'src', path };
  return { kind: 'src', path, start, end };
}

/** 解析链接地址；不是这两种内部格式（或格式不合法）时返回 undefined，界面按普通文字显示 */
export function parseInternalLink(href: string): InternalLink | undefined {
  const h = href.trim();
  if (h.startsWith('sym:')) {
    const id = decode(h.slice(4));
    return id !== undefined && SYMBOL_ID.test(id) ? { kind: 'sym', id } : undefined;
  }
  if (h.startsWith('src:')) return parseSrc(h.slice(4));
  return undefined;
}

export function symLink(id: string): string {
  return `sym:${id}`;
}

export function srcLink(path: string, start?: number, end?: number): string {
  if (start === undefined) return `src:${path}`;
  return `src:${path}#L${start}-L${end ?? start}`;
}

/** Markdown 里 `[文字](sym:<id>)` 链接引用的符号 id，去重，按出现顺序 */
export function symbolLinkIds(markdown: string): string[] {
  const ids = new Set<string>();
  for (const m of markdown.matchAll(/\]\(\s*<?(sym:[^)\s>]+)>?\s*\)/g)) {
    const link = parseInternalLink(m[1]!);
    if (link?.kind === 'sym') ids.add(link.id);
  }
  return [...ids];
}
