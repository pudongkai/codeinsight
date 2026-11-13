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

/** 不带年份和秒的时间，如 `11-13 10:02`，用在顶栏、卡片这类空间小的地方 */
export function formatShortTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

/** 分析结果所基于的代码，如 `基于 abc12345（含未提交改动）` */
export function basedOn(commitSha: string, dirty: boolean): string {
  return `基于 ${shortSha(commitSha)}${dirty ? '（含未提交改动）' : ''}`;
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
