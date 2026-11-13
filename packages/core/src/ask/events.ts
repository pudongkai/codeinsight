/**
 * 问答的流式事件和保存的消息类型（只含类型、常量和纯函数），server、cli 和 web 共用；web 通过 `@codeinsight/core/ask/events` 引用。
 */
import type { SymbolRef } from '../report/types.js';

/** 两个写工具：只生成待确认的修改，不直接写盘 */
export const PROPOSE_FILE_CHANGES = 'propose_file_changes';
export const PROPOSE_PULL_REQUEST = 'propose_pull_request';
export const WRITE_TOOL_NAMES: readonly string[] = [PROPOSE_FILE_CHANGES, PROPOSE_PULL_REQUEST];

export function isWriteTool(name: string): boolean {
  return WRITE_TOOL_NAMES.includes(name);
}

/** 问题的长度上限（按码点计） */
export const MAX_QUESTION_CHARS = 2000;

/** 问题是否超过长度上限：按码点计数（表情等不按两个字符算），server、CLI、Web 共用 */
export function isQuestionTooLong(question: string): boolean {
  return [...question].length > MAX_QUESTION_CHARS;
}

/** 工具出错时回给模型和界面的通用错误码；不含绝对路径和异常原文，详情只写日志 */
export type AskToolError = 'not_found' | 'path_not_allowed' | 'file_changed' | 'file_too_large' | 'invalid_args' | 'overview_missing' | 'write_not_allowed' | 'internal_error';

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
  | { type: 'error'; messageId?: number; code: AskErrorCode; message: string }
  /** 回答保存时一起保存的待确认修改，每条一个事件，在 done 之前发出 */
  | { type: 'proposal'; proposal: ProposalView };

export type ProposalKind = 'files' | 'pull_request';

export type ProposalStatus = 'pending' | 'applying' | 'applied' | 'dismissed' | 'failed';

/** 执行结果或失败原因 */
export interface ProposalResult {
  /** 已写入的文件（失败时为失败前已写入的） */
  written?: string[];
  /** PR 链接 */
  url?: string;
  error?: { code: string; message: string };
  /** 已并入后面的修改（那条记录的 id），本条随之改为 dismissed */
  mergedInto?: number;
}

/** 卡片上的一个文件（不含内容） */
export interface ProposalFileView {
  path: string;
  isNew: boolean;
  deleted?: boolean;
  staleSnapshot?: boolean;
  sensitive?: boolean;
}

/** 待确认修改的展示信息：不含文件内容和绝对路径 */
export interface ProposalView {
  id: number;
  messageId: number;
  kind: ProposalKind;
  status: ProposalStatus;
  /** files 类的说明 */
  summary?: string;
  /** files 类的写入根目录名：repo、dir1 … */
  root?: string;
  /** 仓库以外的写入根目录的目录名（最后一级） */
  rootDir?: string;
  title?: string;
  /** PR 正文：会公开发布，用户确认前要能看到全文 */
  body?: string;
  base?: string;
  branch?: string;
  source?: 'edits' | 'working_tree';
  files: ProposalFileView[];
  /** working_tree 来源的 PR：HEAD 上还没推送到 origin/<base> 的提交（一行标题），会一起进 PR */
  unpushedCommits?: string[];
  /** PR：新分支已推送（建 PR 失败后重试时不再推送） */
  pushed?: boolean;
  result?: ProposalResult;
  /** 保存时没能重新生成：没有可执行的内容，files 只列路径（isNew、staleSnapshot 等不可信） */
  unbuilt?: boolean;
  /** 状态是 applying 但超过时间没有更新（执行卡住或中断），可以重新执行或忽略 */
  retryable?: boolean;
  createdAt: number;
  updatedAt: number;
}

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
