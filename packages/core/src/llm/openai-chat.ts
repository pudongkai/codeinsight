import {
  finishToolCalls, parseEventData, postStream,
  type ChatConnection, type ChatMessage, type ChatRequest, type ChatResult, type ChatStop, type ChatStream, type PendingToolCall,
} from './chat.js';
import { LlmError } from './index.js';

type OpenAiMessage = Record<string, unknown>;

/** 内部消息转 openai 格式：assistant 带 tool_calls（arguments 为 JSON 字符串）；tool 的每个结果一条 tool 消息 */
export function toOpenAiMessages(system: string, messages: ChatMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text });
    else if (m.role === 'tool') for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    else {
      const calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } }));
      out.push({ role: 'assistant', content: m.text || null, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
    }
  }
  return out;
}

export function openAiChatBody(model: string, req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model, max_tokens: req.maxTokens, temperature: 0, stream: true, stream_options: { include_usage: true },
    messages: toOpenAiMessages(req.system, req.messages),
  };
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    body.tool_choice = req.toolChoice ?? 'auto';
  }
  return body;
}

interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: unknown };
}

interface Choice {
  delta?: { content?: string | null; tool_calls?: ToolCallDelta[] };
  /** 不支持流式的服务一次给出完整消息 */
  message?: { content?: string | null; tool_calls?: ToolCallDelta[] };
  finish_reason?: string | null;
}

interface Chunk {
  choices?: Choice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

interface StreamState {
  text: string;
  /** 拼接中的工具调用，按出现顺序 */
  tools: PendingToolCall[];
  /** index → 这个 index 当前在拼接的调用 */
  byIndex: Map<number, PendingToolCall>;
  finish?: string;
  usage?: ChatResult['usage'];
  done: boolean;
}

/**
 * arguments 按分片拼接；有的服务一次给出完整调用，或者给的是对象而不是字符串。
 * 不带 index 的服务按在数组里的位置算；同一 index 出现不同的 id 时是另一个调用。
 */
function addToolDeltas(st: StreamState, deltas: ToolCallDelta[]): void {
  deltas.forEach((d, i) => {
    const index = d.index ?? i;
    let t = st.byIndex.get(index);
    if (!t || (d.id && t.id && d.id !== t.id)) {
      t = { id: '', name: '', args: '' };
      st.tools.push(t);
      st.byIndex.set(index, t);
    }
    if (d.id) t.id = d.id;
    if (d.function?.name) t.name = d.function.name;
    const args = d.function?.arguments;
    if (typeof args === 'string') t.args += args;
    else if (args !== undefined && args !== null) t.args += JSON.stringify(args);
  });
}

function onChunk(chunk: Chunk, st: StreamState, onText?: (delta: string) => void): void {
  if (chunk.usage?.prompt_tokens !== undefined && chunk.usage.completion_tokens !== undefined) {
    st.usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
  }
  const choice = chunk.choices?.[0];
  if (!choice) return;
  const part = choice.delta ?? choice.message;
  if (part?.content) {
    st.text += part.content;
    onText?.(part.content);
  }
  if (part?.tool_calls) addToolDeltas(st, part.tool_calls);
  if (choice.finish_reason) st.finish = choice.finish_reason;
}

function stopOf(reason: string | undefined, hasTools: boolean): ChatStop {
  if (reason === 'length') return 'max_tokens';
  if (reason === 'tool_calls' || reason === 'function_call' || hasTools) return 'tool_use';
  return 'end';
}

async function readChunks(stream: ChatStream, st: StreamState, onText?: (delta: string) => void): Promise<void> {
  // 有的服务不理会 stream: true，直接返回一个完整的 JSON
  if (stream.res.headers.get('content-type')?.includes('application/json')) {
    onChunk(parseEventData<Chunk>(await stream.text()), st, onText);
    st.done = true;
    return;
  }
  for await (const sse of stream.events()) {
    if (sse.data.trim() === '[DONE]') {
      st.done = true;
      break;
    }
    onChunk(parseEventData<Chunk>(sse.data), st, onText);
  }
}

/** openai-compatible Chat Completions 的流式工具调用；服务端不返回 usage 时 usage 为空 */
export async function openAiChat(conn: ChatConnection, req: ChatRequest): Promise<ChatResult> {
  const stream = await postStream(conn, openAiChatBody(conn.model, req), req.signal);
  const st: StreamState = { text: '', tools: [], byIndex: new Map(), done: false };
  await readChunks(stream, st, req.onText);
  if (!st.done && st.finish === undefined) throw new LlmError('stream ended before the reply finished');
  const pending = st.tools.map((t, i) => ({ ...t, id: t.id || `call_${i}` }));
  const stop = stopOf(st.finish ?? undefined, pending.length > 0);
  return { text: st.text, ...finishToolCalls(pending, stop), stop, ...(st.usage ? { usage: st.usage } : {}) };
}
