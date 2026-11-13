import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@codeinsight/core';
import type { AskEvent, ChatMessageInfo, ChatSessionInfo } from '@codeinsight/core';
import { startHttpServer, type RunningHttpServer, type ServerWorkspace } from '../src/index.js';
import {
  fakeLlmEnv, firstUserText, startFakeLlm, toolResults, type FakeLlm, type FakeLlmReply, type FakeLlmRequest,
} from '../../core/test/helpers/fake-llm-server.mjs';
import {
  apiFor, indexReady, openWorkspace, postStream, shopRepo, tempDir, waitFor, type Api, type StreamResponse,
} from './helpers/env.js';

type SessionView = ChatSessionInfo & { answering: boolean; messages: ChatMessageInfo[] };

/** 问题以 hang 开头时写出部分文字后停住；以 search 开头时先调一次工具；其他直接回答 */
function chatReply(req: FakeLlmRequest): FakeLlmReply {
  const q = firstUserText(req);
  if (q.startsWith('hang')) return { text: 'partial answer', hang: true };
  if (q.startsWith('search') && toolResults(req).length === 0) return { toolCalls: [{ name: 'search_symbols', input: { query: 'order' } }] };
  return 'final answer';
}

const prevLevel = process.env.CODEINSIGHT_LOG;
let fake: FakeLlm;
let repo: string;
let dataDir: string;
let ws: ServerWorkspace;
let server: RunningHttpServer;
let api: Api;
const extra: { ws: ServerWorkspace; server: RunningHttpServer }[] = [];

async function startExtra(env: Record<string, string>): Promise<Api> {
  const w = await openWorkspace(repo, dataDir, undefined, env);
  const s = await startHttpServer({ workspace: w, indexOnStart: false });
  extra.push({ ws: w, server: s });
  return apiFor(s);
}

async function newSession(a: Api = api): Promise<number> {
  const r = await a<{ id: number }>('/api/chat/sessions', { method: 'POST', body: {} });
  expect(r.status).toBe(201);
  return r.body.id;
}

function ask(sessionId: number, question: string): Promise<StreamResponse> {
  return postStream(server, `/api/chat/sessions/${sessionId}/messages`, { question });
}

function events(s: StreamResponse): AskEvent[] {
  return s.lines.map((l) => JSON.parse(l) as AskEvent);
}

/** 等到流里出现文字（回答已经开始，假 LLM 停在结束标记之前） */
function textArrived(s: StreamResponse): Promise<true> {
  return waitFor(async () => (events(s).some((e) => e.type === 'text') ? true : undefined), 30_000);
}

function requestFor(question: string): FakeLlmRequest | undefined {
  return fake.requests.find((r) => firstUserText(r) === question);
}

beforeAll(async () => {
  process.env.CODEINSIGHT_LOG = 'silent';
  fake = await startFakeLlm({ reply: chatReply });
  repo = shopRepo();
  dataDir = tempDir('ci-server-chat-');
  ws = await openWorkspace(repo, dataDir, undefined, fakeLlmEnv(fake.url));
  server = await startHttpServer({ workspace: ws });
  api = apiFor(server);
  await indexReady(api);
});

afterAll(async () => {
  for (const e of extra) {
    await e.server.close();
  }
  await server?.close();
  await fake?.close();
  if (prevLevel === undefined) delete process.env.CODEINSIGHT_LOG;
  else process.env.CODEINSIGHT_LOG = prevLevel;
});

describe('chat sessions', () => {
  it('creates, lists, reads and deletes sessions', async () => {
    const id = await newSession();
    const list = (await api<{ sessions: ChatSessionInfo[] }>('/api/chat/sessions')).body.sessions;
    expect(list.map((s) => s.id)).toContain(id);
    const s = (await api<SessionView>(`/api/chat/sessions/${id}`)).body;
    expect(s).toMatchObject({ id, title: '', answering: false, messages: [] });
    expect((await api(`/api/chat/sessions/${id}`, { method: 'DELETE' })).body).toEqual({ deleted: true, cancelled: false });
    expect((await api(`/api/chat/sessions/${id}`)).status).toBe(404);
    expect((await api(`/api/chat/sessions/${id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await api('/api/chat/sessions/abc')).status).toBe(400);
  });

  it('validates the question before answering', async () => {
    const id = await newSession();
    const post = (body: unknown) => api(`/api/chat/sessions/${id}/messages`, { method: 'POST', body });
    expect((await post({})).status).toBe(400);
    expect((await post({ question: '   ' })).status).toBe(400);
    expect((await post({ question: 'x'.repeat(2001) })).status).toBe(400);
    expect((await api('/api/chat/sessions/99999/messages', { method: 'POST', body: { question: 'hi' } })).status).toBe(404);
  });

  it('answers 400 llm_not_configured without an LLM and 503 before the index is ready', async () => {
    const noLlm = await startExtra({});
    const a = await newSession(noLlm);
    const r = await noLlm(`/api/chat/sessions/${a}/messages`, { method: 'POST', body: { question: 'hi' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('llm_not_configured');
    const cold = await startExtra(fakeLlmEnv(fake.url));
    const b = await newSession(cold);
    const r2 = await cold(`/api/chat/sessions/${b}/messages`, { method: 'POST', body: { question: 'hi' } });
    expect(r2.status).toBe(503);
    expect(r2.body.error).toBe('index_not_ready');
  });
});

describe('chat answers', () => {
  it('streams NDJSON events in order and saves the question and answer', async () => {
    const id = await newSession();
    const s = await ask(id, 'search orders please');
    expect(s.status).toBe(200);
    expect(s.headers['content-type']).toMatch(/^application\/x-ndjson/);
    await s.ended;
    const ev = events(s);
    const types = ev.map((e) => e.type).filter((t, i, all) => t !== 'text' || all[i - 1] !== 'text');
    expect(types).toEqual(['start', 'tool', 'tool_done', 'text', 'done']);
    expect(ev[1]).toMatchObject({ type: 'tool', name: 'search_symbols', args: { query: 'order' } });
    const done = ev.at(-1) as Extract<AskEvent, { type: 'done' }>;
    expect(done.status).toBe('done');
    const view = (await api<SessionView>(`/api/chat/sessions/${id}`)).body;
    expect(view.title).toBe('search orders please');
    expect(view.messages.map((m) => [m.role, m.content])).toEqual([['user', 'search orders please'], ['assistant', 'final answer']]);
    expect(view.messages[1]!.id).toBe(done.messageId);
    expect(view.messages[1]!.meta?.status).toBe('done');
  });

  it('rejects a second question in the same session (409) and a third concurrent question (429), cancels on disconnect and on delete', async () => {
    const [s1, s2, s3] = [await newSession(), await newSession(), await newSession()];
    const a = await ask(s1, 'hang one');
    await textArrived(a);
    const busy = await api(`/api/chat/sessions/${s1}/messages`, { method: 'POST', body: { question: 'again' } });
    expect(busy.status).toBe(409);
    expect(busy.body.error).toBe('session_busy');
    const b = await ask(s2, 'hang two');
    await textArrived(b);
    const tooMany = await api(`/api/chat/sessions/${s3}/messages`, { method: 'POST', body: { question: 'third' } });
    expect(tooMany.status).toBe(429);
    expect(tooMany.body.error).toBe('too_many_questions');

    // 客户端断开：假 LLM 的请求被中止，回答记为 cancelled 并保存已收到的文字
    a.destroy();
    await waitFor(async () => (requestFor('hang one')?.aborted ? true : undefined), 30_000);
    const v1 = await waitFor(async () => {
      const v = (await api<SessionView>(`/api/chat/sessions/${s1}`)).body;
      return v.answering ? undefined : v;
    }, 30_000);
    expect(v1.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'partial answer', meta: { status: 'cancelled' } });

    // 删除正在回答的会话：先中止回答，会话和消息都被删除
    const del = await api(`/api/chat/sessions/${s2}`, { method: 'DELETE' });
    expect(del.body).toEqual({ deleted: true, cancelled: true });
    await waitFor(async () => (requestFor('hang two')?.aborted ? true : undefined), 30_000);
    await b.ended;
    expect(events(b).at(-1)).toMatchObject({ type: 'error', code: 'cancelled' });
    expect((await api(`/api/chat/sessions/${s2}`)).status).toBe(404);
    expect(ws.store.chats.messages(s2)).toEqual([]);

    // 名额释放后可以继续提问
    const c = await ask(s3, 'third');
    await c.ended;
    expect(events(c).at(-1)).toMatchObject({ type: 'done', status: 'done' });
  });

  it('cancels answers in progress and waits for them to be saved when the server closes', async () => {
    const w = await openWorkspace(repo, dataDir, undefined, fakeLlmEnv(fake.url));
    const other = await startHttpServer({ workspace: w });
    const a = apiFor(other);
    await indexReady(a);
    const id = await newSession(a);
    const stream = await postStream(other, `/api/chat/sessions/${id}/messages`, { question: 'hang on close' });
    await textArrived(stream);
    await other.close();
    // 关闭服务时它的 Store 也被关闭，重新打开读结果
    const store = new Store(w.layout.dbPath);
    try {
      expect(store.chats.messages(id).at(-1)).toMatchObject({ role: 'assistant', content: 'partial answer', meta: { status: 'cancelled' } });
    } finally {
      store.close();
    }
  });
});
