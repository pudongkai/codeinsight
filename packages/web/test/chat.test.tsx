import type { AskEvent, ChatMessageInfo } from '@codeinsight/core/ask/events';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api/client';
import { readNdjson } from '../src/api/stream';
import type { ChatSessionDetail, StatusResponse } from '../src/api/types';
import { NavContext, type Nav } from '../src/app/nav';
import { useCurrentLinks } from '../src/app/useCurrentLinks';
import { applyEvent, emptyAnswer } from '../src/chat/answer';
import { AnswerMarkdown } from '../src/chat/AnswerMarkdown';
import { ChatPage } from '../src/chat/ChatPage';
import { NOTICE_KEY } from '../src/chat/notice';
import { toolLabel } from '../src/chat/tool-labels';
import { info, makeNav, makeStatus, ref } from './fixtures';

afterEach(() => localStorage.clear());

function LinkedAnswer({ text, refs = {} }: { text: string; refs?: Record<string, ReturnType<typeof ref>> }) {
  const links = useCurrentLinks(7);
  return (
    <>
      <AnswerMarkdown text={text} links={links} refs={refs} answering={false} snapshotId={7} />
      {links.notice && <div data-testid="link-notice">{links.notice}</div>}
    </>
  );
}

function withNav(nav: Nav, node: ReactNode) {
  return render(<NavContext.Provider value={nav}>{node}</NavContext.Provider>);
}

describe('answer markdown', () => {
  it('sym: links open the symbol at its current location via Nav.openSymbol', async () => {
    const nav = makeNav();
    vi.spyOn(api, 'symbol').mockResolvedValue({ symbol: info('refund', { id: 'id-refund', path: 'app/pay.py', startLine: 12 }) } as never);
    withNav(nav, <LinkedAnswer text="见 [refund](sym:id-refund)。" refs={{ 'id-refund': ref('refund', { id: 'id-refund' }) }} />);
    fireEvent.click(screen.getByTestId('sym-link'));
    await waitFor(() => expect(nav.openSymbol).toHaveBeenCalledWith({ snapshotId: 7, id: 'id-refund', name: 'refund', path: 'app/pay.py', line: 12 }));
  });

  it('src: links open the source at the given lines via Nav.openSourceAt', async () => {
    const nav = makeNav();
    vi.spyOn(api, 'source').mockResolvedValue({} as never);
    withNav(nav, <LinkedAnswer text="[service.py:40-120](src:app/billing/service.py#L40-L120)" />);
    fireEvent.click(screen.getByTestId('src-link'));
    await waitFor(() => expect(nav.openSourceAt).toHaveBeenCalledWith({ snapshotId: 7, path: 'app/billing/service.py', start: 40, end: 120 }));
  });

  it('javascript: and http links are rendered as plain text with the address, not clickable', () => {
    withNav(makeNav(), <LinkedAnswer text="[点我](javascript:alert(1)) 和 [文档](https://example.com/x) 和 ![图](https://example.com/a.png)" />);
    const area = screen.getByTestId('answer-text');
    expect(area.querySelector('a')).toBeNull();
    expect(area.querySelector('img')).toBeNull();
    expect(within(area).queryByRole('button')).toBeNull();
    const plain = screen.getAllByTestId('plain-link').map((e) => e.textContent);
    expect(plain).toEqual(['点我（javascript:alert(1)）', '文档（https://example.com/x）']);
  });

  it('HTML in the answer is shown as text, not rendered', () => {
    withNav(makeNav(), <LinkedAnswer text={'前 <b>粗体</b> <img src=x onerror="alert(1)"> 后'} />);
    const area = screen.getByTestId('answer-text');
    expect(area.querySelector('b')).toBeNull();
    expect(area.querySelector('img')).toBeNull();
    expect(area.textContent).toContain('<b>粗体</b>');
    expect(area.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it('a sym: link missing from refs and from the current snapshot is plain text', async () => {
    vi.spyOn(api, 'symbol').mockRejectedValue(new ApiError(404, 'symbol_not_found', 'symbol_not_found'));
    withNav(makeNav(), <LinkedAnswer text="[gone](sym:id-gone)" />);
    await waitFor(() => expect(screen.getByTestId('plain-link').textContent).toBe('gone'));
    expect(screen.queryByTestId('sym-link')).toBeNull();
  });
});

describe('answer state', () => {
  it('accumulates tool steps and text, then ends with the status', () => {
    const events: AskEvent[] = [
      { type: 'start', messageId: 1 },
      { type: 'tool', name: 'search_symbols', args: { query: 'refund' } },
      { type: 'tool_done', name: 'search_symbols', resultChars: 10 },
      { type: 'tool', name: 'read_source', args: { path: 'a.py', start: 40, end: 120 } },
      { type: 'tool_done', name: 'read_source', resultChars: 0, error: 'not_found' },
      { type: 'text', delta: '答' },
      { type: 'text', delta: '案' },
      { type: 'done', messageId: 2, status: 'limited', reason: 'max_rounds', refs: {} },
    ];
    const a = events.reduce(applyEvent, emptyAnswer());
    expect(a).toMatchObject({ text: '答案', status: 'limited', reason: 'max_rounds' });
    expect(a.tools).toEqual([
      { name: 'search_symbols', args: { query: 'refund' }, done: true, error: undefined },
      { name: 'read_source', args: { path: 'a.py', start: 40, end: 120 }, done: true, error: 'not_found' },
    ]);
    expect(applyEvent(a, { type: 'text', delta: 'x' })).toBe(a);
    expect(toolLabel('search_symbols', { query: 'refund' })).toBe('搜索符号 refund');
    expect(toolLabel('read_source', { path: 'server/a.py', start: 40, end: 120 })).toBe('读取 server/a.py:40-120');
  });
});

describe('readNdjson', () => {
  it('splits lines across chunks', async () => {
    const chunks = ['{"a":1}\n{"a"', ':2}\n', '\n{"a":3}'];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const x of chunks) c.enqueue(new TextEncoder().encode(x));
        c.close();
      },
    });
    const got: unknown[] = [];
    await readNdjson(new Response(body), (x) => got.push(x));
    expect(got).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('a malformed line cancels the stream and reports a format error, not a connection error', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"type":"text","delta":"a"}\n{oops\n'));
      },
      cancel,
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));
    const got: AskEvent[] = [];
    const err = await api.ask(1, 'q', (e) => got.push(e)).catch((e: unknown) => e);
    expect(got).toEqual([{ type: 'text', delta: 'a' }]);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('invalid_stream');
    expect((err as ApiError).message).toContain('回答数据格式不对');
    expect(cancel).toHaveBeenCalled();
  });

  it('falls back to reading the whole response when the body cannot be streamed', async () => {
    const res = { body: null, text: async () => '{"a":1}\n{"a":2}\n' } as unknown as Response;
    const got: unknown[] = [];
    await readNdjson(res, (x) => got.push(x));
    expect(got).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

function session(messages: ChatMessageInfo[] = [], extra: Partial<ChatSessionDetail> = {}): ChatSessionDetail {
  return { id: 1, title: '退款', createdAt: 1, updatedAt: 1, answering: false, messages, ...extra };
}

function answerMsg(id: number, content: string, meta: Partial<NonNullable<ChatMessageInfo['meta']>> = {}): ChatMessageInfo {
  return {
    id, sessionId: 1, role: 'assistant', content, createdAt: 1,
    meta: { status: 'done', contentKey: 'ck1', sendSource: true, toolCalls: [], refs: {}, ...meta },
  };
}

const question = (id: number, content: string): ChatMessageInfo => ({ id, sessionId: 1, role: 'user', content, meta: null, createdAt: 1 });

function mockSessions(detail: ChatSessionDetail = session()) {
  vi.spyOn(api, 'chatSessions').mockResolvedValue({ sessions: [{ id: 1, title: '退款', createdAt: 1, updatedAt: 1 }] });
  return vi.spyOn(api, 'chatSession').mockResolvedValue(detail);
}

function renderChat(status: StatusResponse = makeStatus(), nav: Nav = makeNav()) {
  const r = withNav(nav, <ChatPage status={status} />);
  return { ...r, rerenderWith: (s: StatusResponse) => r.rerender(<NavContext.Provider value={nav}><ChatPage status={s} /></NavContext.Provider>) };
}

const accept = (scope = { provider: 'anthropic', model: 'claude-x', sendSource: true }) => localStorage.setItem(NOTICE_KEY, JSON.stringify(scope));

describe('ChatPage first-use notice', () => {
  it('shows the notice until accepted, and again when provider, model or the source switch changes', async () => {
    mockSessions();
    const { rerenderWith } = renderChat();
    expect((await screen.findByTestId('ask-notice')).textContent).toContain('问答会把问题和相关代码发送到 anthropic（claude-x）');
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '退款怎么走' } });
    expect(screen.getByTestId('chat-send')).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByTestId('ask-notice-accept'));
    expect(screen.queryByTestId('ask-notice')).toBeNull();
    expect(JSON.parse(localStorage.getItem(NOTICE_KEY)!)).toEqual({ provider: 'anthropic', model: 'claude-x', sendSource: true });
    await waitFor(() => expect(screen.getByTestId('chat-send')).toHaveProperty('disabled', false));

    rerenderWith(makeStatus({ llm: { provider: 'anthropic', model: 'claude-y' } }));
    expect(screen.getByTestId('ask-notice')).toBeTruthy();
    rerenderWith(makeStatus({ llm: { provider: 'openai-compatible', model: 'claude-x' } }));
    expect(screen.getByTestId('ask-notice')).toBeTruthy();
    rerenderWith(makeStatus({ sendSource: false }));
    expect(screen.getByTestId('ask-notice').textContent).toContain('不发送函数体');
    rerenderWith(makeStatus());
    expect(screen.queryByTestId('ask-notice')).toBeNull();
  });

  it('before the status is loaded shows neither the notice nor the no-LLM help, and cannot send', async () => {
    mockSessions();
    withNav(makeNav(), <ChatPage status={undefined} />);
    await screen.findByTestId('session-item');
    expect(screen.queryByTestId('chat-no-llm')).toBeNull();
    expect(screen.queryByTestId('ask-notice')).toBeNull();
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '问题' } });
    expect(screen.getByTestId('chat-send')).toHaveProperty('disabled', true);
  });

  it('treats an unreadable record as not accepted', async () => {
    localStorage.setItem(NOTICE_KEY, '{not json');
    mockSessions();
    renderChat();
    expect(await screen.findByTestId('ask-notice')).toBeTruthy();
  });

  it('without an LLM explains how to configure one and cannot send', async () => {
    mockSessions();
    renderChat(makeStatus({ llm: null, llmConfigured: false }));
    expect((await screen.findByTestId('llm-setup-help')).textContent).toContain('CODEINSIGHT_LLM_PROVIDER');
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '问题' } });
    expect(screen.getByTestId('chat-send')).toHaveProperty('disabled', true);
  });
});

describe('ChatPage conversation', () => {
  it('shows saved answers with limited, cancelled, failed and stale notes', async () => {
    mockSessions(session([
      question(1, 'q1'), answerMsg(2, 'a1', { status: 'limited', reason: 'max_tokens' }),
      question(3, 'q2'), answerMsg(4, 'a2', { status: 'cancelled' }),
      question(5, 'q3'), answerMsg(6, '', { status: 'failed', error: { code: 'llm_failed', message: 'LLM 请求失败' }, contentKey: 'old' }),
    ]));
    accept();
    renderChat();
    await waitFor(() => expect(screen.getAllByTestId('chat-answer')).toHaveLength(3));
    expect(screen.getAllByTestId('answer-status').map((e) => e.textContent)).toEqual(['回答因长度上限被截断', '已停止', '回答失败：LLM 请求失败']);
    expect(screen.getAllByTestId('answer-stale')).toHaveLength(1);
  });

  it('streams tool progress and text, stops on request, then shows the saved answer', async () => {
    const detail = mockSessions();
    accept();
    let emit!: (e: AskEvent) => void;
    let signal!: AbortSignal;
    vi.spyOn(api, 'ask').mockImplementation((_id, _q, onEvent, s) => {
      emit = onEvent;
      signal = s!;
      return new Promise((_, reject) => s!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    });
    renderChat();
    await screen.findByTestId('session-item');
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '退款怎么走' } });
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(api.ask).toHaveBeenCalledWith(1, '退款怎么走', expect.any(Function), expect.any(AbortSignal)));
    act(() => emit({ type: 'tool', name: 'search_symbols', args: { query: 'refund' } }));
    expect(screen.getByTestId('tool-step').textContent).toBe('搜索符号 refund…');
    act(() => emit({ type: 'text', delta: '先调用' }));
    expect(screen.getByTestId('answer-text').textContent).toBe('先调用');
    detail.mockResolvedValue(session([question(1, '退款怎么走'), answerMsg(2, '先调用', { status: 'cancelled' })]));
    fireEvent.click(screen.getByTestId('chat-stop'));
    expect(signal.aborted).toBe(true);
    await waitFor(() => expect(screen.getByTestId('chat-answer').dataset.status).toBe('cancelled'));
    expect(screen.getByTestId('answer-status').textContent).toBe('已停止');
    await waitFor(() => expect(screen.getAllByTestId('chat-question')).toHaveLength(1));
  });

  it('errors before the answer starts are shown and the question is kept in the input', async () => {
    mockSessions();
    accept();
    vi.spyOn(api, 'ask').mockRejectedValue(new ApiError(409, 'session_busy', 'session_busy: busy'));
    renderChat();
    await screen.findByTestId('session-item');
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '退款怎么走' } });
    fireEvent.click(screen.getByTestId('chat-send'));
    expect((await screen.findByTestId('chat-error')).textContent).toBe('提问失败：这个会话正在回答上一个问题，请等它结束');
    expect(screen.getByTestId('chat-input')).toHaveProperty('value', '退款怎么走');
    expect(screen.queryByTestId('chat-answer')).toBeNull();
  });
});

/** api.ask 的假实现：记下每次调用的事件回调和 AbortSignal，回答一直不结束，中止时以 AbortError 结束 */
function pendingAsks() {
  const calls: { sessionId: number; emit: (e: AskEvent) => void; signal: AbortSignal; finish: () => void }[] = [];
  vi.spyOn(api, 'ask').mockImplementation((sessionId, _q, onEvent, signal) => new Promise<void>((resolve, reject) => {
    calls.push({ sessionId, emit: onEvent, signal: signal!, finish: resolve });
    signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  return calls;
}

async function send(text: string) {
  fireEvent.change(screen.getByTestId('chat-input'), { target: { value: text } });
  fireEvent.click(screen.getByTestId('chat-send'));
}

describe('ChatPage with several sessions', () => {
  it('while session A is answering, session B cannot send or stop A; back in A the stop button stops A', async () => {
    vi.spyOn(api, 'chatSessions').mockResolvedValue({ sessions: [{ id: 1, title: 'A 会话', createdAt: 1, updatedAt: 2 }, { id: 2, title: 'B 会话', createdAt: 1, updatedAt: 1 }] });
    vi.spyOn(api, 'chatSession').mockImplementation(async (id) => session([], { id, answering: false }));
    accept();
    const calls = pendingAsks();
    renderChat();
    await waitFor(() => expect(screen.getAllByTestId('session-item')).toHaveLength(2));
    await send('A 的问题');
    await waitFor(() => expect(calls).toHaveLength(1));
    fireEvent.click(screen.getAllByTestId('session-item')[1]!);
    await waitFor(() => expect(screen.getByTestId('chat-busy').textContent).toBe('会话“A 会话”正在回答，结束后才能提问'));
    expect(screen.queryByTestId('chat-stop')).toBeNull();
    expect(screen.queryByTestId('chat-answer')).toBeNull();
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'B 的问题' } });
    expect(screen.getByTestId('chat-send')).toHaveProperty('disabled', true);
    expect(calls[0]!.signal.aborted).toBe(false);
    fireEvent.click(screen.getAllByTestId('session-item')[0]!);
    fireEvent.click(await screen.findByTestId('chat-stop'));
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('the next question waits until the finished answer is read back, so the previous exchange stays visible', async () => {
    const detail = mockSessions();
    accept();
    const calls = pendingAsks();
    renderChat();
    await screen.findByTestId('session-item');
    let release!: (d: ChatSessionDetail) => void;
    await send('第一问');
    await waitFor(() => expect(calls).toHaveLength(1));
    detail.mockImplementation(() => new Promise((r) => (release = r)));
    act(() => calls[0]!.emit({ type: 'text', delta: '第一答' }));
    act(() => calls[0]!.emit({ type: 'done', status: 'done', refs: {} }));
    await act(async () => calls[0]!.finish());
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '第二问' } });
    expect(screen.getByTestId('chat-send')).toHaveProperty('disabled', true);
    await act(async () => release(session([question(1, '第一问'), answerMsg(2, '第一答')])));
    await waitFor(() => expect(screen.getByTestId('chat-send')).toHaveProperty('disabled', false));
    detail.mockResolvedValue(session([question(1, '第一问'), answerMsg(2, '第一答')]));
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(screen.getAllByTestId('chat-question').map((e) => e.textContent)).toEqual(['第一问', '第二问']);
  });

  it('cannot send in a picked session until its messages are loaded', async () => {
    vi.spyOn(api, 'chatSessions').mockResolvedValue({ sessions: [{ id: 1, title: 'A', createdAt: 1, updatedAt: 2 }, { id: 2, title: 'B', createdAt: 1, updatedAt: 1 }] });
    let releaseB!: (d: ChatSessionDetail) => void;
    vi.spyOn(api, 'chatSession').mockImplementation((id) =>
      id === 1 ? Promise.resolve(session([], { id: 1 })) : new Promise((r) => (releaseB = r)));
    accept();
    const calls = pendingAsks();
    renderChat();
    await waitFor(() => expect(screen.getAllByTestId('session-item')).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId('session-item')[1]!);
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'B 的新问题' } });
    expect(screen.getByTestId('chat-send')).toHaveProperty('disabled', true);
    await act(async () => releaseB(session([{ ...question(7, 'B 旧问题'), sessionId: 2 }, { ...answerMsg(8, 'B 旧回答'), sessionId: 2 }], { id: 2 })));
    await waitFor(() => expect(screen.getByTestId('chat-send')).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.getAllByTestId('chat-question').map((e) => e.textContent)).toEqual(['B 旧问题', 'B 的新问题']);
  });

  it('a session created by the first question shows up in the list while it is being answered', async () => {
    const list = vi.spyOn(api, 'chatSessions').mockResolvedValue({ sessions: [] });
    vi.spyOn(api, 'chatSession').mockResolvedValue(session([], { id: 5 }));
    vi.spyOn(api, 'createChatSession').mockImplementation(async () => {
      list.mockResolvedValue({ sessions: [{ id: 5, title: '新问题', createdAt: 1, updatedAt: 1 }] });
      return { id: 5 };
    });
    accept();
    pendingAsks();
    renderChat();
    await waitFor(() => expect(list).toHaveBeenCalled());
    await send('新问题');
    await waitFor(() => expect(screen.getAllByTestId('session-item')).toHaveLength(1));
    expect(screen.getByTestId('chat-stop')).toBeTruthy();
  });
});
