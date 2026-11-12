import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLlmClient, LlmError, SseParser, ToolsUnsupportedError } from '../src/index.js';
import type { ChatRequest, LlmClient, ToolSpec } from '../src/index.js';
import { startFakeLlm, type FakeLlm, type FakeLlmReply } from './helpers/fake-llm-server.mjs';

/** 请求体按 JSON 结构随意访问，只在测试里用 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

describe('SSE parser', () => {
  it('splits events across chunks, half lines, \\r\\n and comments', () => {
    const p = new SseParser();
    const text = ': ping\r\nevent: a\r\ndata: {"x":\r\ndata: 1}\r\n\r\ndata: second\n\ndata: tail';
    const events = [];
    for (let i = 0; i < text.length; i += 3) events.push(...p.push(text.slice(i, i + 3)));
    events.push(...p.end());
    expect(events).toEqual([{ event: 'a', data: '{"x":\n1}' }, { data: 'second' }, { data: 'tail' }]);
  });

  it('treats a \\r at the end of a chunk followed by \\n as one line break', () => {
    const p = new SseParser();
    expect([...p.push('data: x\r'), ...p.push('\n\r'), ...p.push('\n')]).toEqual([{ data: 'x' }]);
  });
});

const TOOL: ToolSpec = { name: 'search_symbols', description: 'find', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } };

let fake: FakeLlm;
let next: FakeLlmReply = 'hi';
beforeAll(async () => {
  fake = await startFakeLlm({ reply: () => next });
});
afterAll(() => fake.close());

function client(provider: 'anthropic' | 'openai-compatible'): LlmClient {
  return createLlmClient({ provider, model: 'm', baseUrl: provider === 'anthropic' ? fake.url : `${fake.url}/v1`, apiKey: 'k' });
}

async function chat(provider: 'anthropic' | 'openai-compatible', reply: FakeLlmReply, extra: Partial<ChatRequest> = {}) {
  next = reply;
  const deltas: string[] = [];
  const r = await client(provider).chat!({
    system: 'sys', messages: [{ role: 'user', text: 'q' }], tools: [TOOL], maxTokens: 100, onText: (d) => deltas.push(d), ...extra,
  });
  return { r, deltas, req: fake.requests[fake.requests.length - 1]! };
}

describe.each(['anthropic', 'openai-compatible'] as const)('%s chat', (provider) => {
  it('streams text in deltas and reports usage', async () => {
    const { r, deltas } = await chat(provider, { text: 'hello world', chunkChars: 5 });
    expect(r).toMatchObject({ text: 'hello world', toolCalls: [], stop: 'end', usage: { inputTokens: 10, outputTokens: 5 } });
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe('hello world');
  });

  it('assembles one tool call from argument fragments', async () => {
    const { r } = await chat(provider, { text: 'look', toolCalls: [{ id: 'c1', name: 'search_symbols', input: { query: 'refund order' } }], crlf: true, chunkChars: 9 });
    expect(r).toMatchObject({ text: 'look', stop: 'tool_use', toolCalls: [{ id: 'c1', name: 'search_symbols', input: { query: 'refund order' } }] });
  });

  it('returns several tool calls in order, also when each comes whole', async () => {
    const calls = [{ name: 'a', input: { x: 1 } }, { name: 'b', input: { y: 'two' } }];
    for (const wholeToolCalls of [false, true]) {
      const { r } = await chat(provider, { toolCalls: calls, wholeToolCalls });
      expect(r.toolCalls.map((c) => [c.name, c.input])).toEqual([['a', { x: 1 }], ['b', { y: 'two' }]]);
      expect(new Set(r.toolCalls.map((c) => c.id)).size).toBe(2);
    }
  });

  it('keeps the text when the output is cut off in the text', async () => {
    const { r } = await chat(provider, { text: 'partial answ', truncated: true });
    expect(r).toMatchObject({ text: 'partial answ', stop: 'max_tokens', toolCalls: [] });
    expect(r.incompleteToolCall).toBeUndefined();
  });

  it('drops a tool call whose arguments were cut off', async () => {
    const { r } = await chat(provider, { toolCalls: [{ name: 'a', input: { ok: 1 } }, { name: 'b', rawArgs: '{"query": "ref' }], truncated: true });
    expect(r).toMatchObject({ stop: 'max_tokens', incompleteToolCall: true });
    expect(r.toolCalls.map((c) => c.name)).toEqual(['a']);
  });

  it('marks invalid JSON arguments when the stream ended normally', async () => {
    const { r } = await chat(provider, { toolCalls: [{ name: 'a', rawArgs: '{bad' }] });
    expect(r.incompleteToolCall).toBeUndefined();
    expect(r.toolCalls).toMatchObject([{ name: 'a', invalidArgs: true }]);
  });

  it('turns a 400 that mentions tools into ToolsUnsupportedError', async () => {
    const err = await chat(provider, { status: 400, body: { error: { type: 'invalid_request_error', message: 'model does not support tools' } } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolsUnsupportedError);
    const other = await chat(provider, { status: 400, errorType: 'invalid_request_error' }).catch((e: unknown) => e);
    expect(other).toBeInstanceOf(LlmError);
    expect(other).not.toBeInstanceOf(ToolsUnsupportedError);
  });

  it('aborts the request when the signal fires', async () => {
    const ac = new AbortController();
    const p = chat(provider, { text: 'slow', hang: true }, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(LlmError);
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.requests[fake.requests.length - 1]!.aborted).toBe(true);
  });
});

describe('stream timeouts', () => {
  const slow = (delayMs: number): FakeLlmReply => ({ text: 'x'.repeat(200), deltaChars: 10, chunkChars: 200, delayMs });
  const timed = () => createLlmClient({ provider: 'anthropic', model: 'm', baseUrl: fake.url, apiKey: 'k' }, { timeoutMs: 300, idleTimeoutMs: 250 });

  it('keeps reading a long stream past the first-byte timeout while data keeps coming', async () => {
    next = slow(100);
    const started = Date.now();
    const r = await timed().chat!({ system: 's', messages: [{ role: 'user', text: 'q' }], tools: [], maxTokens: 10 });
    expect(Date.now() - started).toBeGreaterThan(300);
    expect(r.text).toBe('x'.repeat(200));
  });

  it('fails when no data arrives for longer than the idle timeout', async () => {
    next = slow(400);
    const err = await timed().chat!({ system: 's', messages: [{ role: 'user', text: 'q' }], tools: [], maxTokens: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as Error).message).toContain('no data from');
  });
});

describe('openai tool calls without index', () => {
  it('starts a new call when the id changes', async () => {
    const calls = [{ id: 'a1', name: 'a', input: { x: 1 } }, { id: 'b2', name: 'b', input: { y: 2 } }];
    for (const wholeToolCalls of [true, false]) {
      const { r } = await chat('openai-compatible', { toolCalls: calls, noIndex: true, wholeToolCalls });
      expect(r.toolCalls.map((c) => [c.id, c.name, c.input])).toEqual([['a1', 'a', { x: 1 }], ['b2', 'b', { y: 2 }]]);
    }
  });
});

describe('request bodies', () => {
  const history: ChatRequest['messages'] = [
    { role: 'user', text: 'q' },
    { role: 'assistant', text: 'let me look', toolCalls: [{ id: 't1', name: 'search_symbols', input: { query: 'x' } }] },
    { role: 'tool', results: [{ id: 't1', content: 'error: not_found: nothing', isError: true }] },
    { role: 'user', text: 'retry note' },
  ];

  it('anthropic: cache_control on system and tools, tool_result blocks merged with the next user text, tool_choice none', async () => {
    const { req } = await chat('anthropic', 'ok', { messages: history, toolChoice: 'none' });
    const b = req.body as Loose;
    expect(b.stream).toBe(true);
    expect(b.system[0]).toMatchObject({ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } });
    expect(b.tools.at(-1)).toMatchObject({ name: 'search_symbols', input_schema: TOOL.inputSchema, cache_control: { type: 'ephemeral' } });
    expect(b.tool_choice).toEqual({ type: 'none' });
    expect(b.messages).toHaveLength(3);
    expect(b.messages[1].content).toEqual([{ type: 'text', text: 'let me look' }, { type: 'tool_use', id: 't1', name: 'search_symbols', input: { query: 'x' } }]);
    expect(b.messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'error: not_found: nothing', is_error: true }, { type: 'text', text: 'retry note' }] });
  });

  it('openai: function tools, tool messages, tool_choice none and include_usage', async () => {
    const { req } = await chat('openai-compatible', 'ok', { messages: history, toolChoice: 'none' });
    const b = req.body as Loose;
    expect(b).toMatchObject({ stream: true, stream_options: { include_usage: true }, tool_choice: 'none' });
    expect(b.tools[0]).toEqual({ type: 'function', function: { name: 'search_symbols', description: 'find', parameters: TOOL.inputSchema } });
    expect(b.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(b.messages[2].tool_calls).toEqual([{ id: 't1', type: 'function', function: { name: 'search_symbols', arguments: '{"query":"x"}' } }]);
    expect(b.messages[3]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'error: not_found: nothing' });
  });

  it('openai: no usage when the service does not send it; a plain JSON reply with tool_calls is accepted', async () => {
    expect((await chat('openai-compatible', { text: 'x', noUsage: true })).r.usage).toBeUndefined();
    const { r } = await chat('openai-compatible', { json: true, toolCalls: [{ id: 'z', name: 'a', input: { q: 1 } }] });
    expect(r).toMatchObject({ stop: 'tool_use', toolCalls: [{ id: 'z', name: 'a', input: { q: 1 } }] });
  });
});
