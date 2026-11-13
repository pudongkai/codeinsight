import { llmLabel } from '../settings/model-label';

/**
 * 问答首次使用提示：确认后在 localStorage 记下当时的 provider、模型和源码发送开关（不含地址和 key），
 * 任一项变化时重新提示；记录读不出或格式不对时按未确认处理。
 */
export const NOTICE_KEY = 'codeinsight.ask.noticeAccepted';

export interface NoticeScope {
  provider: string;
  model: string;
  sendSource: boolean;
}

function readAccepted(): Partial<NoticeScope> | undefined {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(NOTICE_KEY) ?? 'null');
    return v && typeof v === 'object' ? (v as Partial<NoticeScope>) : undefined;
  } catch {
    return undefined;
  }
}

export function noticeAccepted(scope: NoticeScope): boolean {
  const v = readAccepted();
  return v?.provider === scope.provider && v.model === scope.model && v.sendSource === scope.sendSource;
}

/** 写不进 localStorage（如被禁用）时只在本次页面里生效，由调用方保存状态 */
export function acceptNotice(scope: NoticeScope): void {
  try {
    localStorage.setItem(NOTICE_KEY, JSON.stringify({ provider: scope.provider, model: scope.model, sendSource: scope.sendSource }));
  } catch {
    // 忽略：调用方已记住本次确认
  }
}

export function noticeText(scope: NoticeScope): string {
  const to = llmLabel(scope.provider, scope.model);
  return scope.sendSource
    ? `问答会把问题和相关代码发送到 ${to}。`
    : `问答会把问题和函数签名、位置发送到 ${to}，不发送函数体（源码发送已关闭）。`;
}
