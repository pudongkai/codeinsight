import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  askClient, createLlmClient, LIMIT_EMPTY_ANSWER, LIMIT_PROMPT, runAsk, setLogSink, trimHistory, TRUNCATED_ANSWER_NOTE, TRUNCATED_ARGS_PROMPT,
} from '../src/index.js';
import type { AskEvent, AskOptions, LlmClient } from '../src/index.js';
import { askEnv, idOf, type AskEnv } from './helpers/ask-env.js';
import { firstUserText, startFakeLlm, toolResults, type FakeLlm, type FakeLlmReply, type FakeLlmRequest } from './helpers/fake-llm-server.mjs';

let env: AskEnv;
let fake: FakeLlm;
let mode: (req: FakeLlmRequest) => FakeLlmReply = () => 'ok';
beforeAll(async () => {
  process.env.CODEINSIGHT_LOG = 'silent';
  env = await askEnv();
  fake = await startFakeLlm({ reply: (r) => mode(r) });
});
afterAll(async () => {
  env.store.close();
  await fake.close();
});

function client(provider: 'anthropic' | 'openai-compatible' = 'anthropic'): LlmClient {
  return createLlmClient({ provider, model: 'fake', baseUrl: fake.url, apiKey: 'k' });
}

interface Asked {
  result: Awaited<ReturnType<typeof runAsk>>;
  events: AskEvent[];
  sent: FakeLlmRequest[];
}

async function ask(question: string, extra: Partial<AskOptions> = {}): Promise<Asked> {
  const events: AskEvent[] = [];
  const before = fake.requests.length;
  const result = await runAsk({
    repo: env.repo, store: env.store, layout: env.layout, config: env.config, snapshot: env.snapshot,
    client: client(), question, onEvent: (e) => events.push(e), ...extra,
  });
  return { result, events, sent: fake.requests.slice(before) };
}

/** 搜索 refund → 读 orders/service.py 里的 refund → 回答并引用它 */
function searchReadAnswer(req: FakeLlmRequest): FakeLlmReply {
  const results = toolResults(req);
  if (results.length === 0) return { text: '先查一下。', toolCalls: [{ name: 'search_symbols', input: { query: 'refund' } }] };
  if (results.length === 1) return { toolCalls: [{ name: 'read_source', input: { id: idOf(results[0]!, 'refund', 'app/orders/service.py') } }] };
  const id = idOf(results[0]!, 'refund', 'app/orders/service.py');
  return { text: `退款由 [refund](sym:${id}) 处理，见 [service.py:17-20](src:app/orders/service.py#L17-L20)。` };
}

describe.each(['anthropic', 'openai-compatible'] as const)('search → read → answer (%s)', (provider) => {
  it('runs the tools in order, streams the answer and collects refs', async () => {
    mode = searchReadAnswer;
    const { result, events, sent } = await ask('退款流程怎么走？', { client: client(provider) });
    expect(sent).toHaveLength(3);
    expect(sent.every((r) => r.protocol === (provider === 'anthropic' ? 'anthropic' : 'openai'))).toBe(true);
    const kinds = events.map((e) => (e.type === 'tool' || e.type === 'tool_done' ? `${e.type}:${e.name}` : e.type));
    expect(kinds.filter((k) => k !== 'text')).toEqual(['start', 'tool:search_symbols', 'tool_done:search_symbols', 'tool:read_source', 'tool_done:read_source', 'done']);
    expect(kinds.indexOf('text')).toBeGreaterThan(0);
    const third = toolResults(sent[2]!);
    expect(third[1]).toContain('17| def refund(order_id: int) -> dict:');
    expect(result.status).toBe('done');
    expect(result.answer).toContain('先查一下。\n\n退款由 [refund](sym:');
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe(result.answer);
    const refundId = idOf(toolResults(sent[1]!)[0]!, 'refund', 'app/orders/service.py')!;
    expect(result.meta.refs[refundId]).toMatchObject({ name: 'refund', path: 'app/orders/service.py', startLine: 17 });
    expect(result.meta.toolCalls.map((c) => c.name)).toEqual(['search_symbols', 'read_source']);
    expect(result.meta.usage).toEqual({ inputTokens: 30, outputTokens: 15 });
    expect(firstUserText(sent[0]!)).toBe('退款流程怎么走？');
  });
});

describe('ask loop', () => {
  it('returns tool errors to the model without absolute paths and keeps going', async () => {
    mode = (req) => toolResults(req).length === 0
      ? { toolCalls: [{ name: 'read_source', input: { path: `${env.repo}/app/main.py` } }, { name: 'get_symbol', input: { id: 'missing' } }, { name: 'read_source', rawArgs: '{oops' }] }
      : { text: '找不到。' };
    const { result, sent, events } = await ask('读一下 main');
    const results = toolResults(sent[1]!);
    expect(results.map((r) => r.split(':')[1]!.trim())).toEqual(['path_not_allowed', 'not_found', 'invalid_args']);
    expect(results.join('\n')).not.toContain(env.repo);
    const anthropicBlocks = (sent[1]!.body.messages as { content: unknown }[]).at(-1)!.content as { is_error?: boolean }[];
    expect(anthropicBlocks.every((b) => b.is_error)).toBe(true);
    expect(events.filter((e) => e.type === 'tool_done').map((e) => (e as { error?: string }).error)).toEqual(['path_not_allowed', 'not_found', 'invalid_args']);
    expect(result.status).toBe('done');
  });

  it('after maxRounds asks once more without tools, drops tool calls returned anyway and records limited', async () => {
    mode = () => ({ toolCalls: [{ name: 'search_symbols', input: { query: 'order' } }] });
    const { result, sent } = await ask('一直查', { config: { ...env.config, ask: { maxRounds: 2, maxToolChars: 1_000_000 } } });
    expect(sent).toHaveLength(3);
    expect(sent.map((r) => (r.body.tool_choice as { type: string }).type)).toEqual(['auto', 'auto', 'none']);
    expect(JSON.stringify(sent[2]!.body.messages)).toContain(LIMIT_PROMPT);
    expect(result).toMatchObject({ status: 'limited', answer: LIMIT_EMPTY_ANSWER, meta: { reason: 'max_rounds' } });
    expect(result.meta.toolCalls).toHaveLength(2);
  });

  it('stops for the tool result limit and keeps the text of the last round', async () => {
    mode = (req) => (req.body.tool_choice as { type: string }).type === 'none' ? { text: '根据已有信息回答。' } : { toolCalls: [{ name: 'list_entries', input: {} }] };
    const { result, sent } = await ask('列出入口', { config: { ...env.config, ask: { maxRounds: 12, maxToolChars: 10 } } });
    expect(sent).toHaveLength(2);
    expect(result).toMatchObject({ status: 'limited', answer: '根据已有信息回答。', meta: { reason: 'max_tool_chars' } });
  });

  it('stops running tool calls within a round once the tool result limit is passed, still answering each call', async () => {
    mode = (req) => (req.body.tool_choice as { type: string }).type === 'none'
      ? { text: '够了。' }
      : { toolCalls: [1, 2, 3].map((i) => ({ id: `c${i}`, name: 'read_source', input: { path: 'app/long_values.py' } })) };
    const { result, sent } = await ask('读很多', { config: { ...env.config, ask: { maxRounds: 12, maxToolChars: 10 } } });
    expect(sent).toHaveLength(2);
    const results = toolResults(sent[1]!);
    expect(results).toHaveLength(3);
    expect(results[0]).toContain('VALUE_1 = 1');
    expect(results.slice(1).every((r) => r.includes('tool result limit'))).toBe(true);
    expect(result.meta.toolCalls).toHaveLength(1);
    expect(result).toMatchObject({ status: 'limited', answer: '够了。', meta: { reason: 'max_tool_chars' } });
  });

  it('does not write the question or the answer text to the log', async () => {
    mode = (req) => toolResults(req).length === 0
      ? { toolCalls: [{ name: 'search_symbols', input: { query: 'refund' } }] }
      : { text: 'SECRET-ANSWER-TEXT' };
    const lines: string[] = [];
    const prev = setLogSink((l) => lines.push(l));
    process.env.CODEINSIGHT_LOG = 'debug';
    try {
      const { result } = await ask('SECRET-QUESTION-TEXT 怎么退款');
      expect(result.answer).toBe('SECRET-ANSWER-TEXT');
    } finally {
      setLogSink(prev);
      process.env.CODEINSIGHT_LOG = 'silent';
    }
    expect(lines.some((l) => l.includes('ask_started') && l.includes('questionChars='))).toBe(true);
    expect(lines.join('\n')).not.toContain('SECRET-QUESTION-TEXT');
    expect(lines.join('\n')).not.toContain('SECRET-ANSWER-TEXT');
  });

  it('asks again after cut-off tool arguments, and fails with llm_truncated the second time in a row', async () => {
    mode = (req) => toolResults(req).length === 0 && !JSON.stringify(req.body.messages).includes(TRUNCATED_ARGS_PROMPT)
      ? { toolCalls: [{ name: 'search_symbols', rawArgs: '{"query": "ref' }], truncated: true }
      : { text: '好的。' };
    const once = await ask('截断一次');
    expect(once.sent).toHaveLength(2);
    expect(JSON.stringify(once.sent[1]!.body.messages)).toContain(TRUNCATED_ARGS_PROMPT);
    expect(once.result.status).toBe('done');

    mode = () => ({ toolCalls: [{ name: 'search_symbols', rawArgs: '{"query": "ref' }], truncated: true });
    const twice = await ask('截断两次');
    expect(twice.sent).toHaveLength(2);
    expect(twice.result).toMatchObject({ status: 'failed', meta: { error: { code: 'llm_truncated' } } });
    expect(twice.events.at(-1)).toMatchObject({ type: 'error', code: 'llm_truncated' });
  });

  it('keeps a reply cut off in the text as limited with a note', async () => {
    mode = () => ({ text: '回答写到一半', truncated: true });
    const { result } = await ask('长回答');
    expect(result).toMatchObject({ status: 'limited', meta: { reason: 'max_tokens' } });
    expect(result.answer).toBe(`回答写到一半\n\n${TRUNCATED_ANSWER_NOTE}`);
  });

  it('adds refs for sym: links that the tools did not return, only when the symbol exists', async () => {
    const id = env.store.searchSymbols(env.snapshot.id, 'create_order', { limit: 1 })[0]!.id;
    mode = () => ({ text: `见 [create_order](sym:${id}) 和 [x](sym:0000000000000000)` });
    const { result, events } = await ask('下单');
    expect(Object.keys(result.meta.refs)).toEqual([id]);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'done', refs: { [id]: { name: 'create_order' } } });
  });

  it('reports tools_unsupported, cancellation and timeout as error events', async () => {
    mode = () => ({ status: 400, body: { error: { type: 'invalid_request_error', message: 'tools are not supported' } } });
    expect((await ask('q')).result.meta.error?.code).toBe('tools_unsupported');

    mode = () => ({ text: '正在', hang: true });
    const ac = new AbortController();
    const pending = ask('q', { signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    const cancelled = await pending;
    expect(cancelled.result).toMatchObject({ status: 'cancelled', meta: { error: { code: 'cancelled' } } });
    expect(cancelled.events.at(-1)).toMatchObject({ type: 'error', code: 'cancelled' });

    const timedOut = await ask('q', { timeoutMs: 150 });
    expect(timedOut.result).toMatchObject({ status: 'failed', meta: { error: { code: 'timeout' } } });
  });
});

describe('sessions', () => {
  it('saves question and answer, and sends earlier turns without tool results as history', async () => {
    const sessionId = env.store.chats.createSession();
    mode = searchReadAnswer;
    const first = await ask('第一个问题', { sessionId });
    mode = () => ({ text: '第二个回答' });
    const second = await ask('第二个问题', { sessionId });
    const msgs = (second.sent[0]!.body.messages as { role: string; content: unknown }[]);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(msgs[1]!.content)).toContain(first.result.answer.slice(0, 5));
    const saved = env.store.chats.messages(sessionId);
    expect(saved.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(saved[1]!.meta).toMatchObject({ status: 'done', contentKey: env.snapshot.contentKey, sendSource: true });
    expect(saved[1]!.meta!.toolCalls).toHaveLength(2);
    expect(first.events[0]).toEqual({ type: 'start', messageId: saved[0]!.id });
    expect(first.events.at(-1)).toMatchObject({ type: 'done', messageId: saved[1]!.id });
    expect(env.store.chats.getSession(sessionId)!.title).toBe('第一个问题');
  });

  it('keeps the partial answer of a cancelled question', async () => {
    const sessionId = env.store.chats.createSession();
    mode = () => ({ text: '部分回答', hang: true, deltaChars: 100 });
    const ac = new AbortController();
    const pending = ask('q', { sessionId, signal: ac.signal, onEvent: (e) => e.type === 'text' && ac.abort() });
    const { result } = await pending;
    expect(result.status).toBe('cancelled');
    expect(env.store.chats.messages(sessionId).at(-1)).toMatchObject({ role: 'assistant', content: '部分回答', meta: { status: 'cancelled' } });
  });

  it('does not fail when the session is deleted while answering', async () => {
    const sessionId = env.store.chats.createSession();
    mode = searchReadAnswer;
    const lines: string[] = [];
    const prev = setLogSink((l) => lines.push(l));
    process.env.CODEINSIGHT_LOG = 'info';
    try {
      const { result } = await ask('q', { sessionId, onEvent: (e) => e.type === 'tool' && env.store.chats.deleteSession(sessionId) });
      expect(result.status).toBe('done');
      expect(result.messageId).toBeUndefined();
    } finally {
      setLogSink(prev);
      process.env.CODEINSIGHT_LOG = 'silent';
    }
    expect(env.store.chats.getSession(sessionId)).toBeUndefined();
    expect(env.store.chats.messages(sessionId)).toEqual([]);
    expect(lines.some((l) => l.includes('ask_message_not_saved'))).toBe(true);
  });

  it('trims history to the last 10 turns and 20000 characters, dropping the oldest first', () => {
    const turns = Array.from({ length: 12 }, (_, i) => ({ question: `q${i}`, answer: 'a'.repeat(3000) }));
    const kept = trimHistory(turns);
    expect(kept.map((t) => t.question)).toEqual(['q6', 'q7', 'q8', 'q9', 'q10', 'q11']);
    expect(trimHistory(turns.slice(0, 3).map((t) => ({ ...t, answer: 'short' }))).map((t) => t.question)).toEqual(['q0', 'q1', 'q2']);
  });
});

describe('askClient', () => {
  it('reports llm_not_configured with how to configure it', () => {
    const r = askClient({ llm: undefined });
    expect(r).toMatchObject({ code: 'llm_not_configured' });
    expect((r as { message: string }).message).toContain('CODEINSIGHT_LLM_PROVIDER');
    const noChat = askClient({}, { client: { provider: 'x', model: 'm', complete: async () => '' } });
    expect(noChat).toMatchObject({ code: 'llm_not_configured' });
  });
});
