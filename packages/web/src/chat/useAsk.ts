import { useRef, useState } from 'react';
import { api, ApiError, errorMessage } from '../api/client';
import type { ChatSessionDetail } from '../api/types';
import { applyEvent, emptyAnswer, type AnswerView } from './answer';

/** 正在接收（或刚结束、还没从服务端重新读到）的一次问答 */
export interface LiveAnswer {
  sessionId: number;
  question: string;
  /** 提问时会话里已有的消息数：重新读到的消息里，这之后的由 live 显示，直到回答保存完 */
  base: number;
  answer: AnswerView;
}

const START_ERRORS: Record<string, string> = {
  session_busy: '这个会话正在回答上一个问题，请等它结束',
  too_many_questions: '同时在回答的问题太多，请稍后再试',
  llm_not_configured: '未配置 LLM，无法提问',
  index_not_ready: '索引还没建好，稍后再试',
};

function startErrorText(err: ApiError): string {
  return `提问失败：${START_ERRORS[err.code] ?? err.message}`;
}

const ended = (a: AnswerView, f: (a: AnswerView) => AnswerView) => (a.status === 'answering' ? f(a) : a);

interface Options {
  /** 提问时还没有会话则先创建，并选中它 */
  ensureSession(): Promise<number>;
  /** 回答结束（不论成败）后重新读会话列表和消息 */
  reload(): void;
  onIndexNotReady(): void;
}

/**
 * 提问、流式接收、停止；开始前的错误（409、429、400、503）恢复输入框里的问题并提示。
 * 一个页面同时只接收一个回答（live），停止只作用于它。
 */
export function useAsk({ ensureSession, reload, onIndexNotReady }: Options) {
  const [live, setLive] = useState<LiveAnswer>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const abort = useRef<AbortController>(undefined);
  const update = (f: (a: AnswerView) => AnswerView) => setLive((l) => l && { ...l, answer: f(l.answer) });

  const fail = (question: string, err: unknown) => {
    if (err instanceof ApiError && err.status > 0) {
      setLive(undefined);
      setDraft(question);
      setError(startErrorText(err));
      if (err.indexNotReady) onIndexNotReady();
    } else update((a) => ended(a, (x) => ({ ...x, status: 'failed', error: errorMessage(err) })));
  };

  const ask = async (question: string, base: number) => {
    setError(undefined);
    let sessionId: number;
    try {
      sessionId = await ensureSession();
    } catch (err) {
      return setError(`新建会话失败：${errorMessage(err)}`);
    }
    const ctrl = new AbortController();
    abort.current = ctrl;
    setDraft('');
    setLive({ sessionId, question, base, answer: emptyAnswer() });
    try {
      await api.ask(sessionId, question, (e) => update((a) => applyEvent(a, e)), ctrl.signal);
    } catch (err) {
      if (!ctrl.signal.aborted) fail(question, err);
    } finally {
      abort.current = undefined;
      update((a) => ended(a, (x) => ({ ...x, status: 'failed', error: '连接已断开，回答没有完整收到' })));
      reload();
    }
  };

  const stop = () => {
    abort.current?.abort();
    update((a) => ended(a, (x) => ({ ...x, status: 'cancelled' })));
  };

  /** 重新读到的会话里回答已保存完：去掉本地的 live，改用保存的消息 */
  const settle = (d: ChatSessionDetail) => {
    if (!d.answering) setLive((l) => (l && l.sessionId === d.id && l.answer.status !== 'answering' ? undefined : l));
  };

  /** 会话被删除：中止它正在接收的回答并丢掉本地显示 */
  const forget = (sessionId: number) => {
    if (live?.sessionId !== sessionId) return;
    abort.current?.abort();
    setLive(undefined);
  };

  return { live, draft, setDraft, error, ask, stop, settle, forget };
}
