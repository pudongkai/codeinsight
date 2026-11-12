import { isQuestionTooLong, MAX_QUESTION_CHARS } from '@codeinsight/core/ask/events';

interface Props {
  draft: string;
  onDraft(v: string): void;
  answering: boolean;
  /** 不能提问的原因（未配置 LLM、还没确认首次提示等）；有值时发送按钮不可用 */
  blocked: boolean;
  onSend(question: string): void;
  onStop(): void;
}

/** 输入框和发送 / 停止按钮；Enter 发送，Shift+Enter 换行 */
export function Composer({ draft, onDraft, answering, blocked, onSend, onStop }: Props) {
  const tooLong = isQuestionTooLong(draft);
  const canSend = draft.trim() !== '' && !answering && !blocked && !tooLong;
  const send = () => {
    if (canSend) onSend(draft);
  };
  return (
    <div className="chat-composer">
      <textarea data-testid="chat-input" rows={3} value={draft} placeholder="问一个关于这份代码的问题，如“退款流程怎么走”"
        onChange={(e) => onDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }} />
      <div className="actions">
        {tooLong && <span className="warn">问题不能超过 {MAX_QUESTION_CHARS} 个字符</span>}
        {answering
          ? <button type="button" className="small" data-testid="chat-stop" onClick={onStop}>停止</button>
          : <button type="button" className="primary" data-testid="chat-send" disabled={!canSend} onClick={send}>发送</button>}
      </div>
    </div>
  );
}
