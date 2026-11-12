import { log } from '../log.js';
import { completeWithLog, LlmError, LlmTruncatedError, type LlmClient, type LlmMessage } from './index.js';

export type JsonParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface AskJsonRequest<T> {
  client: LlmClient;
  system: string;
  prompt: string;
  maxTokens: number;
  /** 本次请求涉及的条目数，只用于日志 */
  items: number;
  /** 校验回复；不合格时返回原因，原因会告诉模型 */
  parse: (reply: string) => JsonParseResult<T>;
  /** 不合格时追加的用户消息 */
  retryPrompt: (reason: string) => string;
  /** 429 / 5xx 时等待后重试的次数（整个调用合计），默认 0 即不重试 */
  transientRetries?: number;
  /** 回复不合格时的日志事件名 */
  invalidEvent?: string;
}

/** 去掉模型可能加上的 ```json 代码块包裹后按 JSON 解析 */
export function parseJsonReply(text: string): JsonParseResult<unknown> {
  const m = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
  try {
    return { ok: true, value: JSON.parse(m ? m[1]! : text.trim()) as unknown };
  } catch {
    return { ok: false, reason: 'reply is not valid JSON' };
  }
}

export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** 回复不合格时追加的用户消息，把原因告诉模型 */
export function jsonRetryPrompt(reason: string): string {
  return `Your previous reply was rejected: ${reason}. Reply again with JSON only, in the shape given in the instructions.`;
}

export type AskJsonResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: 'request'; error: Error }
  | { ok: false; failure: 'truncated'; error: LlmTruncatedError }
  | { ok: false; failure: 'invalid'; reason: string };

/** 没有 retry-after 时第 n 次重试前等 2s、4s…… */
const BASE_BACKOFF_MS = 2_000;
/** retry-after 过大时最多等这么久，避免一个请求把整个任务挂住 */
const MAX_RETRY_WAIT_MS = 60_000;

/** 可以等待后重试时返回等待毫秒数：限流（429）和服务端错误（5xx），截断不算 */
function transientWait(err: unknown, used: number, allowed: number): number | undefined {
  if (used >= allowed || !(err instanceof LlmError) || err instanceof LlmTruncatedError) return undefined;
  const status = err.status;
  if (status === undefined || (status !== 429 && status < 500)) return undefined;
  return Math.min(err.retryAfterMs ?? BASE_BACKOFF_MS * 2 ** used, MAX_RETRY_WAIT_MS);
}

interface SendState {
  attempt: number;
  transientUsed: number;
}

/** 发一次请求，遇到 429 / 5xx 时按 retry-after（没有则 2s、4s）等待后重试，次数用完或其他错误时抛出 */
async function sendWithRetries<T>(req: AskJsonRequest<T>, messages: LlmMessage[], state: SendState): Promise<string> {
  const { client } = req;
  for (;;) {
    state.attempt++;
    try {
      return await completeWithLog(client, { system: req.system, messages, maxTokens: req.maxTokens }, { items: req.items, attempt: state.attempt });
    } catch (err) {
      const waitMs = transientWait(err, state.transientUsed, req.transientRetries ?? 0);
      if (waitMs === undefined) throw err;
      state.transientUsed++;
      log.warn('llm_retry', { provider: client.provider, model: client.model, attempt: state.attempt, status: (err as LlmError).status, waitMs });
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

/**
 * 请求一个 JSON 回复并校验：不合格时把原因告诉模型重试 1 次，仍不合格就放弃；
 * 回复被截断不重试（同样的输入多半还会截断）；429 / 5xx 按 transientRetries 等待后重试。
 */
export async function askJson<T>(req: AskJsonRequest<T>): Promise<AskJsonResult<T>> {
  const messages: LlmMessage[] = [{ role: 'user', content: req.prompt }];
  const state: SendState = { attempt: 0, transientUsed: 0 };
  for (let round = 1; ; round++) {
    let reply: string;
    try {
      reply = await sendWithRetries(req, messages, state);
    } catch (err) {
      if (err instanceof LlmTruncatedError) return { ok: false, failure: 'truncated', error: err };
      return { ok: false, failure: 'request', error: err as Error };
    }
    const parsed = req.parse(reply);
    if (parsed.ok) return parsed;
    log.warn(req.invalidEvent ?? 'llm_response_invalid', { model: req.client.model, attempt: state.attempt, reason: parsed.reason });
    if (round === 2) return { ok: false, failure: 'invalid', reason: parsed.reason };
    messages.push({ role: 'assistant', content: reply }, { role: 'user', content: req.retryPrompt(parsed.reason) });
  }
}
