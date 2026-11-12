import type { ChatMessageInfo } from '@codeinsight/core/ask/events';
import { savedAnswer, statusNote, type AnswerView } from './answer';
import { AnswerMarkdown, type AnswerLinks } from './AnswerMarkdown';
import { ToolSteps } from './ToolSteps';

interface AnswerProps {
  answer: AnswerView;
  links: AnswerLinks;
  snapshotId: number | undefined;
  /** 当前快照的 content_key，与回答所用的不同时提示位置可能有变化 */
  currentContentKey: string | undefined;
}

/** 一条回答：过期提示、工具调用进度、正文和结束状态 */
export function AnswerBlock({ answer, links, snapshotId, currentContentKey }: AnswerProps) {
  const answering = answer.status === 'answering';
  const stale = answer.contentKey !== undefined && currentContentKey !== undefined && answer.contentKey !== currentContentKey;
  const note = statusNote(answer);
  return (
    <div className="chat-msg assistant" data-testid="chat-answer" data-status={answer.status}>
      {stale && <div className="notice" data-testid="answer-stale">基于较早的代码，位置可能有变化</div>}
      <ToolSteps tools={answer.tools} answering={answering} />
      {answer.text && <AnswerMarkdown text={answer.text} links={links} refs={answer.refs} answering={answering} snapshotId={snapshotId} />}
      {answering && <p className="muted" data-testid="answering">正在回答…</p>}
      {note && <p className={answer.status === 'failed' ? 'error-inline' : 'warn'} data-testid="answer-status">{note}</p>}
    </div>
  );
}

export function Question({ text }: { text: string }) {
  return <div className="chat-msg user" data-testid="chat-question">{text}</div>;
}

type ListProps = Omit<AnswerProps, 'answer'> & { messages: ChatMessageInfo[] };

/** 已保存的问题和回答，按时间顺序 */
export function MessageList({ messages, ...rest }: ListProps) {
  return (
    <>
      {messages.map((m) =>
        m.role === 'user'
          ? <Question key={m.id} text={m.content} />
          : <AnswerBlock key={m.id} answer={savedAnswer(m.content, m.meta)} {...rest} />,
      )}
    </>
  );
}
