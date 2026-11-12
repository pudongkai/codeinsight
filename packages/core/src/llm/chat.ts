import { log } from '../log.js';
import { httpError, LlmError, originOf, sendPost, ToolsUnsupportedError, type LlmClient } from './index.js';
import { readSse, type SseEvent } from './sse.js';

/** 工具定义：inputSchema 为 JSON Schema */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  /** 流已正常结束但参数不是合法 JSON；input 为 undefined，调用方作为参数错误回给模型 */
  invalidArgs?: boolean;
}

export type ChatMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; results: { id: string; content: string; isError?: boolean }[] };

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  toolChoice?: 'auto' | 'none';
  maxTokens: number;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
}

export type ChatStop = 'end' | 'tool_use' | 'max_tokens';

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  /** 截断发生在工具参数里：不完整的工具调用已丢弃 */
  incompleteToolCall?: boolean;
  stop: ChatStop;
  usage?: ChatUsage;
}

/** 一种协议的请求地址和认证头 */
export interface ChatConnection {
  url: string;
  headers: Record<string, string>;
  model: string;
  /** 连接到收到第一段数据的超时 */
  timeoutMs: number;
  /** 之后两次收到数据之间的超时，默认 DEFAULT_IDLE_TIMEOUT_MS */
  idleTimeoutMs?: number;
}

/** 400 错误的 type / code / message 里提到 tool 或 function 时，认为是模型不支持工具调用 */
function mentionsTools(text: string): boolean {
  try {
    const err = (JSON.parse(text) as { error?: Record<string, unknown> } | null)?.error;
    return ['type', 'code', 'message'].some((k) => typeof err?.[k] === 'string' && /tool|function/i.test(err[k] as string));
  } catch {
    return false;
  }
}

/** 收到第一段数据后，两次收到数据之间最多等这么久 */
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

/**
 * 流式请求的超时：连接到收到第一段数据之前用 firstMs，之后每收到一段数据重新计时为 idleMs。
 * 慢的本地模型长回答可以持续输出很久，只要不长时间没有数据就不中止；整个问题的总时长由调用方控制。
 */
class StreamTimer {
  private readonly ctrl = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  readonly signal = this.ctrl.signal;

  constructor(private readonly url: string, firstMs: number, private readonly idleMs: number) {
    this.arm(firstMs);
  }

  private arm(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.ctrl.abort(new LlmError(`no data from ${originOf(this.url)} within ${Math.round(ms / 1000)}s`)), ms);
  }

  touch(): void {
    this.arm(this.idleMs);
  }

  stop(): void {
    clearTimeout(this.timer);
  }
}

/** 已连接的流式响应；读完或出错后计时器自动停止 */
export interface ChatStream {
  res: Response;
  /** 逐条读 SSE 事件；读流出错（中止、超时、连接断开）转成 LlmError */
  events(): AsyncGenerator<SseEvent>;
  /** 服务端没有按流式返回时，读出整个响应体 */
  text(): Promise<string>;
}

/** 读流出错转成 LlmError；超时时 abort 的原因本身就是 LlmError */
function streamError(err: unknown, url: string): LlmError {
  if (err instanceof LlmError) return err;
  return new LlmError(`stream from ${originOf(url)} failed: ${(err as Error).message}`);
}

async function* streamEvents(res: Response, url: string, timer: StreamTimer): AsyncGenerator<SseEvent> {
  try {
    if (!res.body) throw new LlmError('response has no body', res.status);
    yield* readSse(res.body, () => timer.touch());
  } catch (err) {
    throw streamError(err, url);
  } finally {
    timer.stop();
  }
}

async function readAll(res: Response, url: string, timer: StreamTimer): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    throw streamError(err, url);
  } finally {
    timer.stop();
  }
}

/**
 * 发出流式请求，返回成功的响应。连接和第一段数据用 conn.timeoutMs，之后为空闲超时；调用方的 signal 中止时一并中止。
 * 400 且错误里提到工具时抛 ToolsUnsupportedError。
 */
export async function postStream(conn: ChatConnection, body: unknown, signal?: AbortSignal): Promise<ChatStream> {
  const timer = new StreamTimer(conn.url, conn.timeoutMs, conn.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
  try {
    const res = await sendPost(conn.url, conn.headers, body, signal ? AbortSignal.any([timer.signal, signal]) : timer.signal);
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 400 && mentionsTools(text)) throw new ToolsUnsupportedError();
      throw httpError(res, text);
    }
    return { res, events: () => streamEvents(res, conn.url, timer), text: () => readAll(res, conn.url, timer) };
  } catch (err) {
    timer.stop();
    throw err;
  }
}

/** SSE data 解析为 JSON；不合格时抛 LlmError（不回显内容） */
export function parseEventData<T>(data: string): T {
  try {
    return JSON.parse(data) as T;
  } catch {
    throw new LlmError('stream event is not JSON');
  }
}

/** 工具参数 JSON；空串按无参数处理，不是合法 JSON 时 ok 为 false */
export function parseToolArgs(raw: string): { ok: true; value: unknown } | { ok: false } {
  if (raw.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

/** 拼接中的工具调用（两种协议的流式解析共用） */
export interface PendingToolCall {
  id: string;
  name: string;
  args: string;
}

/**
 * 流结束后把拼好的工具调用转成结果：参数不是合法 JSON 时，若输出被截断则丢弃并标记 incompleteToolCall，
 * 否则保留并标记 invalidArgs。
 */
export function finishToolCalls(pending: PendingToolCall[], stop: ChatStop): Pick<ChatResult, 'toolCalls' | 'incompleteToolCall'> {
  const toolCalls: ToolCall[] = [];
  let incomplete = false;
  for (const p of pending) {
    const parsed = parseToolArgs(p.args);
    if (parsed.ok) toolCalls.push({ id: p.id, name: p.name, input: parsed.value });
    else if (stop === 'max_tokens') incomplete = true;
    else toolCalls.push({ id: p.id, name: p.name, input: undefined, invalidArgs: true });
  }
  return incomplete ? { toolCalls, incompleteToolCall: true } : { toolCalls };
}

function promptChars(req: ChatRequest): number {
  let n = req.system.length;
  for (const m of req.messages) {
    if (m.role === 'user') n += m.text.length;
    else if (m.role === 'assistant') n += m.text.length + m.toolCalls.reduce((k, c) => k + JSON.stringify(c.input ?? null).length, 0);
    else n += m.results.reduce((k, r) => k + r.content.length, 0);
  }
  return n;
}

/**
 * 调用 client.chat 并记日志：地址只到 origin、模型、轮次、消息数、工具数、输出上限、耗时、工具调用数和用量；
 * 不记 API key、请求体和工具结果。
 */
export async function chatWithLog(client: LlmClient, req: ChatRequest, meta: { round: number }): Promise<ChatResult> {
  if (!client.chat) throw new LlmError('LLM client does not support chat');
  const started = Date.now();
  const base = { provider: client.provider, model: client.model, round: meta.round };
  const endpoint = client.baseUrl ? originOf(client.baseUrl) : undefined;
  log.info('llm_chat_request', { ...base, endpoint, messages: req.messages.length, tools: req.tools.length, toolChoice: req.toolChoice ?? 'auto', maxTokens: req.maxTokens, promptChars: promptChars(req) });
  try {
    const r = await client.chat(req);
    log.info('llm_chat_response', { ...base, ms: Date.now() - started, chars: r.text.length, toolCalls: r.toolCalls.length, stop: r.stop, incompleteToolCall: r.incompleteToolCall, inputTokens: r.usage?.inputTokens, outputTokens: r.usage?.outputTokens });
    return r;
  } catch (err) {
    const aborted = req.signal?.aborted === true;
    log.warn(aborted ? 'llm_chat_aborted' : 'llm_chat_failed', { ...base, ms: Date.now() - started, status: (err as LlmError).status, error: (err as Error).message.split('\n')[0] });
    throw err;
  }
}
