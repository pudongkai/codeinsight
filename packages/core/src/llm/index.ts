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
  complete(req: LlmRequest): Promise<string>;
}

export class LlmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
/** 错误响应只保留开头部分写进错误信息，避免把大段响应体带进日志 */
const ERROR_BODY_CHARS = 300;

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
    throw new LlmError(`request to ${new URL(url).origin} failed: ${(err as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new LlmError(`HTTP ${res.status}: ${text.slice(0, ERROR_BODY_CHARS)}`, res.status);
  try {
    return JSON.parse(text);
  } catch {
    throw new LlmError(`response is not JSON: ${text.slice(0, ERROR_BODY_CHARS)}`, res.status);
  }
}

class AnthropicClient implements LlmClient {
  readonly provider = 'anthropic';
  constructor(readonly model: string, private readonly cfg: LlmConfig, private readonly timeoutMs: number) {}

  async complete(req: LlmRequest): Promise<string> {
    const base = (this.cfg.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/+$/, '');
    const headers: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION };
    if (this.cfg.apiKey) headers['x-api-key'] = this.cfg.apiKey;
    const body = { model: this.model, max_tokens: req.maxTokens, system: req.system, messages: req.messages };
    const json = (await postJson(`${base}/v1/messages`, headers, body, this.timeoutMs)) as { content?: { type: string; text?: string }[] };
    const text = (json.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    if (!text) throw new LlmError('response has no text content');
    return text;
  }
}

class OpenAiCompatibleClient implements LlmClient {
  readonly provider = 'openai-compatible';
  constructor(readonly model: string, private readonly cfg: LlmConfig, private readonly timeoutMs: number) {}

  async complete(req: LlmRequest): Promise<string> {
    const base = (this.cfg.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, '');
    const headers: Record<string, string> = this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {};
    const messages = [{ role: 'system', content: req.system }, ...req.messages];
    const body = { model: this.model, max_tokens: req.maxTokens, temperature: 0, messages };
    const json = (await postJson(`${base}/chat/completions`, headers, body, this.timeoutMs)) as { choices?: { message?: { content?: string } }[] };
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

/** 记录一次请求的模型、条目数、耗时和结果；不记录 API key 和请求体 */
export async function completeWithLog(client: LlmClient, req: LlmRequest, meta: { items: number; attempt: number }): Promise<string> {
  const started = Date.now();
  log.info('llm_request', { provider: client.provider, model: client.model, items: meta.items, attempt: meta.attempt, promptChars: req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0) });
  try {
    const text = await client.complete(req);
    log.info('llm_response', { provider: client.provider, model: client.model, attempt: meta.attempt, ms: Date.now() - started, chars: text.length });
    return text;
  } catch (err) {
    log.warn('llm_failed', { provider: client.provider, model: client.model, attempt: meta.attempt, ms: Date.now() - started, status: (err as LlmError).status, error: (err as Error).message.split('\n')[0] });
    throw err;
  }
}
