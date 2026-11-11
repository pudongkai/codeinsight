/**
 * HTTP API 客户端：页面里所有接口调用都经过这里。
 * 认证只靠 serve 设置的 HttpOnly cookie（同源请求自动带上），前端不接触 token。
 */
import type {
  EntryItem, ReviewParams, ReviewResponse, SourceResponse, StatusResponse, SymbolDetail, SymbolInfo, TreeResponse,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }

  get snapshotGone(): boolean {
    return this.status === 410 && this.code === 'snapshot_gone';
  }

  get indexNotReady(): boolean {
    return this.status === 503 && this.code === 'index_not_ready';
  }

  /** 认证失效或资源不存在：重试也不会成功 */
  get permanent(): boolean {
    return this.status === 401 || this.status === 404;
  }
}

async function request<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new ApiError(0, 'network_error', `无法连接到 codeinsight serve：${(err as Error).message}`);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) {
    const code = data.error ?? `http_${res.status}`;
    throw new ApiError(res.status, code, data.message ? `${code}: ${data.message}` : code);
  }
  return data as T;
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

const sym = (snapshot: number, id: string) => `/api/symbols/${snapshot}/${encodeURIComponent(id)}`;

export const api = {
  status: () => request<StatusResponse>('GET', '/api/status'),
  startIndex: () => request<{ id: number; status: string }>('POST', '/api/index'),
  createReview: (params: ReviewParams) => request<{ id: number }>('POST', '/api/reviews', params),
  review: (id: number) => request<ReviewResponse>('GET', `/api/reviews/${id}`),
  search: (q: string, limit = 50) => request<{ snapshotId: number; results: SymbolInfo[] }>('GET', `/api/symbols/search${qs({ q, limit })}`),
  entries: () => request<{ snapshotId: number; entries: EntryItem[] }>('GET', '/api/entries'),
  symbol: (snapshot: number, id: string) => request<SymbolDetail>('GET', sym(snapshot, id)),
  callers: (snapshot: number, id: string, depth = 1) => request<TreeResponse>('GET', `${sym(snapshot, id)}/callers${qs({ depth })}`),
  callees: (snapshot: number, id: string, depth = 1) => request<TreeResponse>('GET', `${sym(snapshot, id)}/callees${qs({ depth })}`),
  source: (snapshot: number, path: string, start?: number, end?: number) =>
    request<SourceResponse>('GET', `/api/source${qs({ snapshot, path, start, end })}`),
};

export type Api = typeof api;

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return (err as Error)?.message ?? String(err);
}
