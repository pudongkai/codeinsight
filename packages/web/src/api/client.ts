/**
 * HTTP API 客户端：页面里所有接口调用都经过这里。
 * 认证只靠 serve 设置的 HttpOnly cookie（同源请求自动带上），前端不接触 token。
 * 读到 status 后，之后的请求都带 `X-CodeInsight-Repo: <repoGen>`：仓库被别的页面切换后，服务端返回 409 repo_changed，
 * 页面收到通知后重新读 status 并重建仓库相关的内容。
 */
import type { AskEvent, ChatSessionInfo } from '@codeinsight/core/ask/events';
import { NdjsonParseError, readNdjson } from './stream';
import type {
  ChatSessionDetail, EntryItem, LlmForm, LlmTestResult, OpenRepoResult, OverviewEstimate, OverviewJob, OverviewParams, OverviewResponse, PickDirResult,
  ReposResponse, ReviewParams, ReviewResponse, SettingsResponse, SourceResponse, StatusResponse, SymbolDetail, SymbolInfo, TreeResponse,
} from './types';

export const REPO_HEADER = 'X-CodeInsight-Repo';

/** 最近一次 status 的 repoGen；还没读到 status 时为 undefined，此时请求不带仓库标识 */
let repoGen: number | null | undefined;
const repoChangedListeners = new Set<() => void>();

/** 订阅“服务端的当前仓库已不是页面所用的仓库”（409 repo_changed）；返回取消订阅函数 */
export function onRepoChanged(listener: () => void): () => void {
  repoChangedListeners.add(listener);
  return () => repoChangedListeners.delete(listener);
}

/** 测试用：回到还没读到 status 的状态 */
export function resetRepoGen(): void {
  repoGen = undefined;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** 错误响应里 error、message 之外的字段（如 needs_confirm 的 estimate） */
    readonly extra: Record<string, unknown> = {},
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

  get repoChanged(): boolean {
    return this.status === 409 && this.code === 'repo_changed';
  }
}

/** fetch 网络失败时的错误 */
function networkError(err: unknown): ApiError {
  return new ApiError(0, 'network_error', `无法连接到 codeinsight serve：${(err as Error).message}`);
}

/** 非 2xx 响应转成 ApiError：错误体为 `{error, message, ...extra}` */
async function responseError(res: Response): Promise<ApiError> {
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string } & Record<string, unknown>;
  const { error, message, ...extra } = data;
  const code = error ?? `http_${res.status}`;
  const err = new ApiError(res.status, code, message ? `${code}: ${message}` : code, extra);
  if (err.repoChanged) for (const l of repoChangedListeners) l();
  return err;
}

function headersFor(body: unknown): Record<string, string> | undefined {
  const h: Record<string, string> = {};
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (repoGen !== undefined) h[REPO_HEADER] = String(repoGen);
  return Object.keys(h).length > 0 ? h : undefined;
}

/** 带 JSON 请求体的同源请求；网络失败时抛 network_error */
async function send(method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: headersFor(body),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw networkError(err);
  }
}

async function request<T>(method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await send(method, url, body, signal);
  if (!res.ok) throw await responseError(res);
  return (await res.json().catch(() => ({}))) as T;
}

/** POST 后按 NDJSON 逐行读取响应；非 2xx 时抛 ApiError（开始前的错误是普通 JSON） */
async function postNdjson<T>(url: string, body: unknown, onItem: (item: T) => void, signal?: AbortSignal): Promise<void> {
  const res = await send('POST', url, body, signal);
  if (!res.ok) throw await responseError(res);
  try {
    await readNdjson(res, onItem);
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err instanceof NdjsonParseError) throw new ApiError(0, 'invalid_stream', `回答数据格式不对（${err.message}）`);
    throw new ApiError(0, 'stream_broken', `连接中断：${(err as Error).message}`);
  }
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

const sym = (snapshot: number, id: string) => `/api/symbols/${snapshot}/${encodeURIComponent(id)}`;

async function status(): Promise<StatusResponse> {
  const s = await request<StatusResponse>('GET', '/api/status');
  repoGen = s.repoGen;
  return s;
}

export const api = {
  status,
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
  overview: (id?: number) => request<OverviewResponse>('GET', `/api/overview${qs({ id })}`),
  overviewEstimate: (p: OverviewParams) => request<OverviewEstimate>('GET', `/api/overview/estimate${qs({ noLlm: p.noLlm, noSource: p.noSource })}`),
  createOverview: (p: OverviewParams & { confirmed?: boolean }) => request<{ id: number; reused?: boolean }>('POST', '/api/overview', p),
  overviewJob: (id: number) => request<OverviewJob>('GET', `/api/overview/jobs/${id}`),
  chatSessions: () => request<{ sessions: ChatSessionInfo[] }>('GET', '/api/chat/sessions'),
  createChatSession: () => request<{ id: number }>('POST', '/api/chat/sessions', {}),
  chatSession: (id: number) => request<ChatSessionDetail>('GET', `/api/chat/sessions/${id}`),
  deleteChatSession: (id: number) => request<{ deleted: boolean; cancelled: boolean }>('DELETE', `/api/chat/sessions/${id}`),
  /** 提问：开始前的错误抛 ApiError，开始后逐个回调事件；signal 中止即停止回答 */
  ask: (sessionId: number, question: string, onEvent: (e: AskEvent) => void, signal?: AbortSignal) =>
    postNdjson<AskEvent>(`/api/chat/sessions/${sessionId}/messages`, { question }, onEvent, signal),
  repos: () => request<ReposResponse>('GET', '/api/repos'),
  openRepo: (path: string, cancelRunning = false) => request<OpenRepoResult>('POST', '/api/repo', { path, cancelRunning }),
  /** 在 serve 所在的机器上弹出系统选择文件夹窗口，等用户选完才返回 */
  /** signal 中止时断开请求，服务端随之结束弹窗 */
  pickDir: (signal?: AbortSignal) => request<PickDirResult>('POST', '/api/repo/pick-dir', {}, signal),
  removeRecentRepo: (path: string) => request<unknown>('DELETE', `/api/repos/recent${qs({ path })}`),
  settings: () => request<SettingsResponse>('GET', '/api/settings'),
  saveLlmSettings: (form: LlmForm) => request<SettingsResponse>('POST', '/api/settings/llm', form),
  testLlm: (form: LlmForm) => request<LlmTestResult>('POST', '/api/settings/llm/test', form),
  saveGeneralSettings: (p: { autoReindex: boolean }) => request<SettingsResponse>('POST', '/api/settings', p),
};

export type Api = typeof api;

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return (err as Error)?.message ?? String(err);
}
