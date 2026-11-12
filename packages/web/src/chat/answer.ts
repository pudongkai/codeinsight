import type { AskEvent, AskLimitReason, AskMessageMeta, AskStatus, AskToolError } from '@codeinsight/core/ask/events';
import type { SymbolRef } from '@codeinsight/core/report/types';
import { LIMIT_LABELS } from './tool-labels';

export interface ToolStep {
  name: string;
  args: Record<string, unknown>;
  done: boolean;
  error?: AskToolError;
}

/** 一条回答的显示内容：正在流式接收的回答和已保存的回答共用 */
export interface AnswerView {
  text: string;
  tools: ToolStep[];
  status: 'answering' | AskStatus;
  reason?: AskLimitReason;
  error?: string;
  refs: Record<string, SymbolRef>;
  /** 回答所用快照的 content_key；正在接收的回答没有 */
  contentKey?: string;
}

export const emptyAnswer = (): AnswerView => ({ text: '', tools: [], status: 'answering', refs: {} });

/** 已保存的回答 */
export function savedAnswer(content: string, meta: AskMessageMeta | null): AnswerView {
  if (!meta) return { ...emptyAnswer(), text: content, status: 'done' };
  return {
    text: content,
    tools: meta.toolCalls.map((c) => ({ name: c.name, args: c.args, done: true, error: c.error })),
    status: meta.status,
    reason: meta.reason,
    error: meta.error?.message,
    refs: meta.refs,
    contentKey: meta.contentKey,
  };
}

/** 把工具完成事件记到最后一个同名、还没完成的调用上 */
function finishTool(tools: ToolStep[], name: string, error?: AskToolError): ToolStep[] {
  const i = tools.findLastIndex((t) => t.name === name && !t.done);
  if (i < 0) return tools;
  return tools.map((t, j) => (j === i ? { ...t, done: true, error } : t));
}

/** 流式事件累积成回答；已经结束（如用户点了停止）的回答不再变化 */
export function applyEvent(a: AnswerView, e: AskEvent): AnswerView {
  if (a.status !== 'answering') return a;
  switch (e.type) {
    case 'tool':
      return { ...a, tools: [...a.tools, { name: e.name, args: e.args, done: false }] };
    case 'tool_done':
      return { ...a, tools: finishTool(a.tools, e.name, e.error) };
    case 'text':
      return { ...a, text: a.text + e.delta };
    case 'done':
      return { ...a, status: e.status, reason: e.reason, refs: e.refs };
    case 'error':
      return e.code === 'cancelled' ? { ...a, status: 'cancelled' } : { ...a, status: 'failed', error: e.message };
    default:
      return a;
  }
}

/** 回答末尾的状态说明；正常完成时没有 */
export function statusNote(a: AnswerView): string | undefined {
  if (a.status === 'cancelled') return '已停止';
  if (a.status === 'failed') return `回答失败：${a.error ?? '未知错误'}`;
  if (a.status === 'limited') return a.reason ? LIMIT_LABELS[a.reason] : '已达到上限，回答可能不完整';
  return undefined;
}
