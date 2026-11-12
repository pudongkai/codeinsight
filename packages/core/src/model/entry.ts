/**
 * 入口相关的纯函数：HTTP 接口判断和方法路径文字。
 * 不依赖 Node 模块，web 通过 `@codeinsight/core/model/entry` 直接引用。
 */

/** 入口的最小字段：EntryRow、报告里的 EntryInfo、API 返回的入口都满足 */
export interface EntryLike {
  kind: string;
  framework: string;
  detail: Record<string, unknown>;
}

/** HTTP 接口：kind 为 http 的入口；FastAPI 中间件也记为 http 入口，但不是接口 */
export function isHttpApi<T extends EntryLike>(entry: T | undefined): entry is T & { kind: 'http' } {
  return entry?.kind === 'http' && entry.detail.middleware === undefined;
}

/** 入口 detail 里的字符串字段，不是字符串时为空串 */
export function entryText(entry: EntryLike, key: string): string {
  const v = entry.detail[key];
  return typeof v === 'string' ? v : '';
}

/** 接口的方法和路径，如 `GET /users/{id}`；Django 路由没有方法时只有路径 */
export function httpRoute(entry: EntryLike): string {
  return `${entryText(entry, 'method')} ${entryText(entry, 'path')}`.trim();
}
