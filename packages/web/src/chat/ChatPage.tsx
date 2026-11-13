import { useRef } from 'react';
import { api } from '../api/client';
import type { ChatSessionDetail, StatusResponse } from '../api/types';
import { useNav } from '../app/nav';
import { useCurrentLinks } from '../app/useCurrentLinks';
import { LlmSetupHint } from '../settings/LlmSetupHint';
import { Composer } from './Composer';
import { AnswerBlock, MessageList, Question } from './MessageList';
import { noticeText } from './notice';
import { SessionList } from './SessionList';
import { useAsk, type LiveAnswer } from './useAsk';
import { useAskNotice } from './useAskNotice';
import { useChatSessions } from './useChatSessions';

/** 未配置模型服务时的引导，或首次使用（provider、模型、源码开关变化后）的发送提示 */
function AskGate({ notice }: { notice: ReturnType<typeof useAskNotice> }) {
  if (!notice.known) return null;
  if (!notice.scope) {
    return (
      <div className="notice" data-testid="chat-no-llm">
        <LlmSetupHint what="，不能使用问答" />
      </div>
    );
  }
  if (notice.accepted) return null;
  return (
    <div className="notice" data-testid="ask-notice">
      {noticeText(notice.scope)}{' '}
      <button type="button" className="small" data-testid="ask-notice-accept" onClick={notice.accept}>知道了</button>
    </div>
  );
}

interface ConversationProps {
  detail: ChatSessionDetail | undefined;
  live: LiveAnswer | undefined;
  links: ReturnType<typeof useCurrentLinks>;
  status: StatusResponse | undefined;
}

/** 已保存的消息，加上正在接收的这次问答（回答保存完、重新读到之前由它显示） */
function Conversation({ detail, live, links, status }: ConversationProps) {
  const messages = detail?.messages ?? [];
  const shared = { links, snapshotId: status?.snapshot?.id, currentContentKey: status?.snapshot?.contentKey };
  return (
    <div className="chat-messages" data-testid="chat-messages">
      <MessageList messages={live ? messages.slice(0, live.base) : messages} {...shared} />
      {live && <Question text={live.question} />}
      {live && <AnswerBlock answer={live.answer} {...shared} />}
      {!live && detail?.answering && <p className="muted" data-testid="answering-elsewhere">这个会话正在回答一个问题，完成后显示。</p>}
      {!live && messages.length === 0 && <p className="muted">提问后，AI 会查询代码索引（符号、调用关系、源码）来回答，回答里的符号和源码位置可以点击打开。</p>}
    </div>
  );
}

interface SendState {
  /** 当前会话的回答正在接收：显示“停止” */
  answering: boolean;
  blocked: boolean;
  /** 另一个会话正在回答时的说明 */
  busyNote?: string;
}

/**
 * 发送按钮的状态：页面同时只接收一个回答，另一个会话在回答时这里不能提问；
 * 当前会话的回答刚结束、还没重新读到保存的消息时也先不能提问（新问答要接在保存的消息后面）。
 */
function sendState(live: LiveAnswer | undefined, currentId: number | undefined, titleOf: (id: number) => string, ready: boolean): SendState {
  const liveAnswering = live?.answer.status === 'answering';
  const here = live !== undefined && live.sessionId === currentId;
  if (live && liveAnswering && !here) {
    return { answering: false, blocked: true, busyNote: `会话“${titleOf(live.sessionId)}”正在回答，结束后才能提问` };
  }
  return { answering: here && liveAnswering, blocked: !ready || (here && !liveAnswering) };
}

/** 问答页：左侧会话列表，右侧对话和输入框 */
export function ChatPage({ status }: { status: StatusResponse | undefined }) {
  const nav = useNav();
  const links = useCurrentLinks(status?.snapshot?.id);
  const notice = useAskNotice(status);
  const settle = useRef<(d: ChatSessionDetail) => void>(() => undefined);
  const s = useChatSessions((d) => settle.current(d));
  const ensureSession = async () => {
    if (s.currentId !== undefined) return s.currentId;
    const { id } = await api.createChatSession();
    s.pick(id);
    s.reload();
    return id;
  };
  const ask = useAsk({ ensureSession, reload: s.reload, onIndexNotReady: nav.indexNotReady });
  settle.current = ask.settle;
  const live = ask.live && ask.live.sessionId === s.currentId ? ask.live : undefined;
  const titleOf = (id: number) => s.list.find((x) => x.id === id)?.title || '新会话';
  // 选中的会话还没读到消息时不能提问：新问答要接在已有消息后面显示
  const detailLoaded = s.currentId === undefined || s.detail !== undefined;
  const send = sendState(ask.live, s.currentId, titleOf, notice.accepted && detailLoaded);
  const remove = (id: number) => {
    ask.forget(id);
    void s.remove(id);
  };
  return (
    <div className="chat-page" data-testid="chat-page">
      <SessionList sessions={s.list} currentId={s.currentId} isNew={s.isNew} onPick={s.pick} onDelete={remove} />
      <section className="panel chat-main">
        <AskGate notice={notice} />
        {[s.error, s.detailError, ask.error].filter(Boolean).map((e) => <div key={e} className="error" data-testid="chat-error">{e}</div>)}
        {links.notice && <div className="notice" data-testid="link-notice">{links.notice}</div>}
        <Conversation detail={s.detail} live={live} links={links} status={status} />
        {send.busyNote && <p className="muted" data-testid="chat-busy">{send.busyNote}</p>}
        <Composer draft={ask.draft} onDraft={ask.setDraft} answering={send.answering} blocked={send.blocked}
          onSend={(q) => void ask.ask(q, s.detail?.messages.length ?? 0)} onStop={ask.stop} />
      </section>
    </div>
  );
}
