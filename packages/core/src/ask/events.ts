/**
 * 问答的流式事件和保存的消息类型（只含类型、常量和纯函数），server、cli 和 web 共用；web 通过 `@codeinsight/core/ask/events` 引用。
 */
import type { SymbolRef } from '../report/types.js';

/** 问题的长度上限（按码点计） */
export const MAX_QUESTION_CHARS = 2000;

/** 问题是否超过长度上限：按码点计数（表情等不按两个字符算），server、CLI、Web 共用 */
export function isQuestionTooLong(question: string): boolean {
  return [...question].length > MAX_QUESTION_CHARS;
}

/** 工具出错时回给模型和界面的通用错误码；不含绝对路径和异常原文，详情只写日志 */
export type AskToolError = 'not_found' | 'path_not_allowed' | 'file_changed' | 'file_too_large' | 'invalid_args' | 'overview_missing' | 'internal_error';

/** 问答提前结束的原因 */
export type AskErrorCode = 'llm_failed' | 'tools_unsupported' | 'llm_truncated' | 'timeout' | 'cancelled' | 'internal_error';

/** 达到上限时的原因 */
export type AskLimitReason = 'max_rounds' | 'max_tool_chars' | 'max_tokens';

export interface AskUsage {
  inputTokens: number;
  outputTokens: number;
  /** 用量是按字符数估算的（本机 CLI 没有返回用量时） */
  estimated?: true;
  /** 本机 CLI 返回的费用（美元） */
  costUsd?: number;
}

export type AskEvent =
  /** messageId：保存到会话时用户问题那条消息的 id；不保存会话时不存在 */
  | { type: 'start'; messageId?: number }
  | { type: 'tool'; name: string; args: Record<string, unknown> }
  | { type: 'tool_done'; name: string; resultChars: number; error?: AskToolError }
  | { type: 'text'; delta: string }
  /** messageId：保存到会话时回答那条消息的 id */
  | { type: 'done'; messageId?: number; status: 'done' | 'limited'; reason?: AskLimitReason; refs: Record<string, SymbolRef>; usage?: AskUsage }
  | { type: 'error'; messageId?: number; code: AskErrorCode; message: string };

export type AskStatus = 'done' | 'failed' | 'cancelled' | 'limited';

export interface AskToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  resultChars: number;
  ms: number;
  error?: AskToolError;
}

/** assistant 消息的 meta；不存工具返回的原文 */
export interface AskMessageMeta {
  status: AskStatus;
  reason?: AskLimitReason;
  /** 回答所用快照的 content_key，与当前快照不同时界面提示“基于较早的代码” */
  contentKey: string;
  sendSource: boolean;
  toolCalls: AskToolCallRecord[];
  refs: Record<string, SymbolRef>;
  usage?: AskUsage;
  error?: { code: AskErrorCode; message: string };
}

export interface ChatSessionInfo {
  id: number;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessageInfo {
  id: number;
  sessionId: number;
  role: 'user' | 'assistant';
  content: string;
  /** user 消息为 null */
  meta: AskMessageMeta | null;
  createdAt: number;
}
