import type { LlmConfig, LlmProvider } from '../config/index.js';
import { log } from '../log.js';
import { anthropicChat } from './anthropic-chat.js';
import type { ChatRequest, ChatResult } from './chat.js';
import { openAiChat } from './openai-chat.js';

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  maxTokens: number;
}

/** LLM 客户端：发一轮对话，返回模型回复的文本。测试里注入假的实现 */
export interface LlmClient {
  readonly provider: LlmProvider | (string & {});
  readonly model: string;
  /** 请求的基础地址，用于缓存 key；日志里只记它的 origin */
  readonly baseUrl?: string;
  /** 回复因达到 maxTokens 被截断时抛 LlmTruncatedError */
  complete(req: LlmRequest): Promise<string>;
  /**
   * 流式对话，支持工具调用（问答用）。可选：测试里只实现 complete 的假客户端不用改；
   * createLlmClient 返回的客户端都实现。模型不支持工具时抛 ToolsUnsupportedError。
   */
  chat?(req: ChatRequest): Promise<ChatResult>;
}

export class LlmError extends Error {
  /**
   * @param status 服务端返回的 HTTP 状态码；请求没发出去或没有响应时为 undefined
   * @param retryAfterMs 错误响应带了可解析的 `retry-after` 头时，建议等待的毫秒数
   */
  constructor(message: string, readonly status?: number, readonly retryAfterMs?: number) {
    super(message);
  }
}

/** 模型回复达到输出上限被截断（anthropic 的 stop_reason=max_tokens、openai 的 finish_reason=length） */
export class LlmTruncatedError extends LlmError {
  constructor(readonly maxTokens: number) {
    super(`reply was cut off at the output limit (max_tokens=${maxTokens})`);
  }
}

/** 服务端返回 400 且错误里提到 tools / function：当前模型不支持工具调用 */
export class ToolsUnsupportedError extends LlmError {
  constructor() {
    super('the model does not support tool calling; use a model that supports function calling', 400);
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
/** 没有配置 baseUrl 时 anthropic 的请求地址 */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
/** 没有配置 baseUrl 时 openai-compatible 的请求地址 */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
/** 错误类型字段只保留这么多字符，且只留标识符字符 */
const ERROR_TYPE_CHARS = 64;

/** 错误类型字段只留标识符字符并限制长度；不是字符串或数字时返回 undefined */
export function cleanErrorType(raw: unknown): string | undefined {
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  return String(raw).replace(/[^\w.-]/g, '').slice(0, ERROR_TYPE_CHARS) || undefined;
}

/**
 * 从错误响应里取错误类型字段（anthropic 的 error.type、openai 的 error.code / error.type）。
 * 不回显响应体其他内容：自定义地址返回的内容不可信，可能很大或带有请求里的信息。
 */
function errorType(text: string): string | undefined {
  try {
    const err = (JSON.parse(text) as { error?: { type?: unknown; code?: unknown } } | null)?.error;
    return cleanErrorType(err?.type ?? err?.code);
  } catch {
    return undefined;
  }
}

/** URL 的 origin，日志里只记这一部分，不带路径和查询参数 */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'invalid-url';
  }
}

/** `retry-after` 头：秒数或 HTTP 日期，转成毫秒；格式不对时返回 undefined */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export interface JsonResponse {
  json: unknown;
  headers: Headers;
}

/**
 * 发出 POST 请求，返回原始响应（不检查状态码）。请求没发出去、没有响应或被 signal 中止时抛 LlmError；
 * 是用户取消还是超时由调用方看自己的 signal 判断。
 */
export async function sendPost(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  } catch (err) {
    throw new LlmError(`request to ${originOf(url)} failed: ${(err as Error).message}`);
  }
}

/** 非 2xx 响应转成 LlmError：只带状态码、错误类型字段和 retry-after */
export function httpError(res: Response, text: string): LlmError {
  const type = errorType(text);
  return new LlmError(`HTTP ${res.status}${type ? ` (${type})` : ''}`, res.status, parseRetryAfter(res.headers.get('retry-after')));
}

export async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<JsonResponse> {
  const res = await sendPost(url, headers, body, AbortSignal.timeout(timeoutMs));
  const text = await res.text();
  if (!res.ok) throw httpError(res, text);
  try {
    return { json: JSON.parse(text), headers: res.headers };
  } catch {
    throw new LlmError('response is not JSON', res.status);
  }
}

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
}

class AnthropicClient implements LlmClient {
  readonly provider = 'anthropic';
  readonly baseUrl: string;
  constructor(readonly model: string, private readonly cfg: LlmConfig, private readonly timeoutMs: number, private readonly idleTimeoutMs?: number) {
    this.baseUrl = (cfg.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION };
    if (this.cfg.apiKey) headers['x-api-key'] = this.cfg.apiKey;
    return headers;
  }

  async complete(req: LlmRequest): Promise<string> {
    const body = { model: this.model, max_tokens: req.maxTokens, system: req.system, messages: req.messages };
    const json = (await postJson(`${this.baseUrl}/v1/messages`, this.headers(), body, this.timeoutMs)).json as AnthropicResponse;
    if (json.stop_reason === 'max_tokens') throw new LlmTruncatedError(req.maxTokens);
    const text = (json.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    if (!text) throw new LlmError('response has no text content');
    return text;
  }

  chat(req: ChatRequest): Promise<ChatResult> {
    return anthropicChat({ url: `${this.baseUrl}/v1/messages`, headers: this.headers(), model: this.model, timeoutMs: this.timeoutMs, idleTimeoutMs: this.idleTimeoutMs }, req);
  }
}

interface OpenAiResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
}

class OpenAiCompatibleClient implements LlmClient {
  readonly provider = 'openai-compatible';
  readonly baseUrl: string;
  constructor(readonly model: string, private readonly cfg: LlmConfig, private readonly timeoutMs: number, private readonly idleTimeoutMs?: number) {
    this.baseUrl = (cfg.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    return this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {};
  }

  async complete(req: LlmRequest): Promise<string> {
    const messages = [{ role: 'system', content: req.system }, ...req.messages];
    const body = { model: this.model, max_tokens: req.maxTokens, temperature: 0, messages };
    const json = (await postJson(`${this.baseUrl}/chat/completions`, this.headers(), body, this.timeoutMs)).json as OpenAiResponse;
    if (json.choices?.[0]?.finish_reason === 'length') throw new LlmTruncatedError(req.maxTokens);
    const text = json.choices?.[0]?.message?.content;
    if (!text) throw new LlmError('response has no message content');
    return text;
  }

  chat(req: ChatRequest): Promise<ChatResult> {
    return openAiChat({ url: `${this.baseUrl}/chat/completions`, headers: this.headers(), model: this.model, timeoutMs: this.timeoutMs, idleTimeoutMs: this.idleTimeoutMs }, req);
  }
}

/**
 * 按配置创建客户端。anthropic 必须有 API key；openai-compatible 的本地服务（如 Ollama）可以不带 key。
 * 缺少 key 时抛错，调用方转成 warning。
 */
export function createLlmClient(cfg: LlmConfig, opts: { timeoutMs?: number; idleTimeoutMs?: number } = {}): LlmClient {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (cfg.provider === 'anthropic') {
    if (!cfg.apiKey) throw new LlmError('anthropic API key is missing (set CODEINSIGHT_LLM_API_KEY or ANTHROPIC_API_KEY)');
    return new AnthropicClient(cfg.model, cfg, timeoutMs, opts.idleTimeoutMs);
  }
  return new OpenAiCompatibleClient(cfg.model, cfg, timeoutMs, opts.idleTimeoutMs);
}

/** 记录一次请求的地址（只到 origin）、模型、条目数、输出上限、耗时和结果；不记录 API key 和请求体 */
export async function completeWithLog(client: LlmClient, req: LlmRequest, meta: { items: number; attempt: number }): Promise<string> {
  const started = Date.now();
  const promptChars = req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0);
  const endpoint = client.baseUrl ? originOf(client.baseUrl) : undefined;
  log.info('llm_request', { provider: client.provider, endpoint, model: client.model, items: meta.items, attempt: meta.attempt, maxTokens: req.maxTokens, promptChars });
  try {
    const text = await client.complete(req);
    log.info('llm_response', { provider: client.provider, model: client.model, attempt: meta.attempt, ms: Date.now() - started, chars: text.length });
    return text;
  } catch (err) {
    const truncated = err instanceof LlmTruncatedError;
    log.warn(truncated ? 'llm_truncated' : 'llm_failed', { provider: client.provider, model: client.model, attempt: meta.attempt, ms: Date.now() - started, status: (err as LlmError).status, retryAfterMs: (err as LlmError).retryAfterMs, error: (err as Error).message.split('\n')[0] });
    throw err;
  }
}
