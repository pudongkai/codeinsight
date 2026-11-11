import type { Route } from './context.js';
import { HttpError } from './respond.js';

export interface Match {
  route: Route;
  params: Record<string, string>;
}

/**
 * 按路径段匹配路由：先按 `/` 切分原始路径，再逐段解码，`%2f` 不会产生新的路径段。
 * 路径匹配但方法不对时抛 405。
 */
export function matchRoute(routes: Route[], method: string, pathname: string): Match | undefined {
  const segs = pathname.split('/');
  let methodMismatch = false;
  for (const route of routes) {
    const params = matchPattern(route.pattern.split('/'), segs);
    if (!params) continue;
    if (route.method === method || (route.method === 'GET' && method === 'HEAD')) return { route, params };
    methodMismatch = true;
  }
  if (methodMismatch) throw new HttpError(405, 'method_not_allowed');
  return undefined;
}

function matchPattern(pattern: string[], segs: string[]): Record<string, string> | undefined {
  if (pattern.length !== segs.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    const s = segs[i]!;
    if (p.startsWith(':')) {
      if (s === '') return undefined;
      params[p.slice(1)] = decodeSegment(s);
    } else if (p !== s) return undefined;
  }
  return params;
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, 'invalid_path');
  }
}
