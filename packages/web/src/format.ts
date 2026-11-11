import type { SymbolChangeKind } from '@codeinsight/core/report/types';

export const CHANGE_LABELS: Record<SymbolChangeKind, string> = {
  added: '新增',
  removed: '删除',
  modified: '修改',
  signature_changed: '签名变化',
  moved: '搬家',
};

export function formatTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

/** 入口的简短描述，如 `HTTP POST /orders/{id}`、`celery task` */
export function entryLabel(e: { kind: string; framework: string; detail: Record<string, unknown> }): string {
  const method = typeof e.detail.method === 'string' ? e.detail.method : '';
  const path = typeof e.detail.path === 'string' ? e.detail.path : '';
  if (e.kind === 'http' && (method || path)) return `${e.framework} ${method} ${path}`.replace(/\s+/g, ' ').trim();
  const extra = ['name', 'event', 'exception', 'middleware'].map((k) => e.detail[k]).find((v) => typeof v === 'string' && v !== '');
  return `${e.framework} ${e.kind}${extra ? ` ${String(extra)}` : ''}`;
}

/** 代码位置的统一写法 `path:line` */
export function location(path: string, line: number): string {
  return `${path}:${line}`;
}
