import {
  finishToolCalls, parseEventData, postStream,
  type ChatConnection, type ChatMessage, type ChatRequest, type ChatResult, type ChatStop, type PendingToolCall,
} from './chat.js';
import { cleanErrorType, LlmError } from './index.js';

type Block = Record<string, unknown>;
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: Block[];
}

/**
 * 内部消息转 anthropic 格式：assistant → text + tool_use 块；tool → user 消息里的 tool_result 块。
 * 相邻的 user 消息（工具结果后追加的提示）合并成一条。
 */
export function toAnthropicMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  const push = (role: AnthropicMessage['role'], blocks: Block[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role && role === 'user') last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'user') push('user', [{ type: 'text', text: m.text }]);
    else if (m.role === 'tool') push('user', m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })));
    else {
      const blocks: Block[] = m.text ? [{ type: 'text', text: m.text }] : [];
      for (const c of m.toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input ?? {} });
      push('assistant', blocks);
    }
  }
  return out;
}

/** 请求体：系统提示和最后一个工具定义上加 cache_control，工具循环里每轮重复的前缀能命中提示缓存 */
export function anthropicChatBody(model: string, req: ChatRequest): Record<string, unknown> {
  const cache = { cache_control: { type: 'ephemeral' } };
  const body: Record<string, unknown> = {
    model, max_tokens: req.maxTokens, stream: true,
    system: [{ type: 'text', text: req.system, ...cache }],
    messages: toAnthropicMessages(req.messages),
  };
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t, i) => ({ name: t.name, description: t.description, input_schema: t.inputSchema, ...(i === req.tools.length - 1 ? cache : {}) }));
    body.tool_choice = { type: req.toolChoice ?? 'auto' };
  }
  return body;
}

interface StreamEvent {
  type: string;
  index?: number;
  content_block?: { type: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string };
}

interface StreamState {
  text: string;
  /** 块序号 → 拼接中的工具调用 */
  tools: Map<number, PendingToolCall>;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
}

function onEvent(ev: StreamEvent, st: StreamState, onText?: (delta: string) => void): void {
  if (ev.type === 'message_start') st.inputTokens = ev.message?.usage?.input_tokens;
  else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
    st.tools.set(ev.index ?? st.tools.size, { id: ev.content_block.id ?? `toolu_${ev.index}`, name: ev.content_block.name ?? '', args: '' });
  } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
    st.text += ev.delta.text;
    onText?.(ev.delta.text);
  } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta') {
    const t = st.tools.get(ev.index ?? -1);
    if (t) t.args += ev.delta.partial_json ?? '';
  } else if (ev.type === 'message_delta') {
    st.stopReason = ev.delta?.stop_reason ?? st.stopReason;
    st.outputTokens = ev.usage?.output_tokens ?? st.outputTokens;
  } else if (ev.type === 'error') {
    const type = cleanErrorType(ev.error?.type);
    throw new LlmError(`stream error${type ? ` (${type})` : ''}`);
  }
}

function stopOf(reason: string | undefined): ChatStop {
  if (reason === 'max_tokens') return 'max_tokens';
  if (reason === 'tool_use') return 'tool_use';
  return 'end';
}

/** anthropic Messages API 的流式工具调用 */
export async function anthropicChat(conn: ChatConnection, req: ChatRequest): Promise<ChatResult> {
  const stream = await postStream(conn, anthropicChatBody(conn.model, req), req.signal);
  const st: StreamState = { text: '', tools: new Map() };
  for await (const sse of stream.events()) {
    onEvent(parseEventData<StreamEvent>(sse.data), st, req.onText);
  }
  if (st.stopReason === undefined) throw new LlmError('stream ended before the reply finished');
  const stop = stopOf(st.stopReason);
  const usage = st.inputTokens !== undefined && st.outputTokens !== undefined ? { usage: { inputTokens: st.inputTokens, outputTokens: st.outputTokens } } : {};
  return { text: st.text, ...finishToolCalls([...st.tools.values()], stop), stop, ...usage };
}
