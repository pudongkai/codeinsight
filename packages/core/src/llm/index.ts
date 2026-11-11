import type { LlmConfig, LlmProvider } from '../config/index.js';
import { log } from '../log.js';

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
}

export class LlmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** 模型回复达到输出上限被截断（anthropic 的 stop_reason=max_tokens、openai 的 finish_reason=length） */
export class LlmTruncatedError extends LlmError {
  constructor(readonly maxTokens: number) {
    super(`reply was cut off at the output limit (max_tokens=${maxTokens})`);
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
/** 错误类型字段只保留这么多字符，且只留标识符字符 */
const ERROR_TYPE_CHARS = 64;

/**
 * 从错误响应里取错误类型字段（anthropic 的 error.type、openai 的 error.code / error.type）。
 * 不回显响应体其他内容：自定义地址返回的内容不可信，可能很大或带有请求里的信息。
 */
function errorType(text: string): string | undefined {
  try {
    const err = (JSON.parse(text) as { error?: { type?: unknown; code?: unknown } } | null)?.error;
    const raw = err?.type ?? err?.code;
    if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
    const clean = String(raw).replace(/[^\w.-]/g, '').slice(0, ERROR_TYPE_CHARS);
    return clean || undefined;
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

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new LlmError(`request to ${originOf(url)} failed: ${(err as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    const type = errorType(text);
    throw new LlmError(`HTTP ${res.status}${type ? ` (${type})` : ''}`, res.status);
  }
  try {
    return JSON.parse(text);
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
  constructor(readonly model: string, private readonly cfg: LlmConfig, private readonly timeoutMs: number) {
    this.baseUrl = (cfg.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/+$/, '');
  }

  async complete(req: LlmRequest): Promise<string> {
    const headers: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION };
    if (this.cfg.apiKey) headers['x-api-key'] = this.cfg.apiKey;
    const body = { model: this.model, max_tokens: req.maxTokens, system: req.system, messages: req.messages };
    const json = (await postJson(`${this.baseUrl}/v1/messages`, headers, body, this.timeoutMs)) as AnthropicResponse;
    if (json.stop_reason === 'max_tokens') throw new LlmTruncatedError(req.maxTokens);
    const text = (json.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    if (!text) throw new LlmError('response has no text content');
    return text;
  }
}

interface OpenAiResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
}

class OpenAiCompatibleClient implements LlmClient {
  readonly provider = 'openai-compatible';
  readonly baseUrl: string;
  constructor(readonly model: string, private readonly cfg: LlmConfig, private readonly timeoutMs: number) {
    this.baseUrl = (cfg.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, '');
  }

  async complete(req: LlmRequest): Promise<string> {
    const headers: Record<string, string> = this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {};
    const messages = [{ role: 'system', content: req.system }, ...req.messages];
    const body = { model: this.model, max_tokens: req.maxTokens, temperature: 0, messages };
    const json = (await postJson(`${this.baseUrl}/chat/completions`, headers, body, this.timeoutMs)) as OpenAiResponse;
    if (json.choices?.[0]?.finish_reason === 'length') throw new LlmTruncatedError(req.maxTokens);
    const text = json.choices?.[0]?.message?.content;
    if (!text) throw new LlmError('response has no message content');
    return text;
  }
}

/**
 * 按配置创建客户端。anthropic 必须有 API key；openai-compatible 的本地服务（如 Ollama）可以不带 key。
 * 缺少 key 时抛错，调用方转成 warning。
 */
export function createLlmClient(cfg: LlmConfig, opts: { timeoutMs?: number } = {}): LlmClient {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (cfg.provider === 'anthropic') {
    if (!cfg.apiKey) throw new LlmError('anthropic API key is missing (set CODEINSIGHT_LLM_API_KEY or ANTHROPIC_API_KEY)');
    return new AnthropicClient(cfg.model, cfg, timeoutMs);
  }
  return new OpenAiCompatibleClient(cfg.model, cfg, timeoutMs);
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
    log.warn(truncated ? 'llm_truncated' : 'llm_failed', { provider: client.provider, model: client.model, attempt: meta.attempt, ms: Date.now() - started, status: (err as LlmError).status, error: (err as Error).message.split('\n')[0] });
    throw err;
  }
}
