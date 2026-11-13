import type { LlmMessage } from '../index.js';

/**
 * 多条消息拼成一条用户消息（CLI 一次只接受一条输入）。askJson 重试时消息是 user / assistant / user：
 * 第一条原样放在最前，之后每条 assistant 回复和跟着的用户意见按标题附在后面。
 */
export function flattenMessages(messages: readonly LlmMessage[]): string {
  const [first, ...rest] = messages;
  const parts = first ? [first.content] : [];
  for (const m of rest) {
    parts.push(m.role === 'assistant' ? `Your previous reply:\n${m.content}` : `Feedback on your previous reply:\n${m.content}`);
  }
  return parts.join('\n\n');
}
