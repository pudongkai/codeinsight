import { isCliProvider } from '@codeinsight/core/settings/types';

const PROVIDER_NAMES: Record<string, string> = { 'claude-code': 'Claude Code', opencode: 'opencode' };

/** provider 的显示名：本机 CLI 用工具名，API provider 原样显示 */
export function providerName(provider: string | null | undefined): string {
  return provider ? (PROVIDER_NAMES[provider] ?? provider) : '';
}

/**
 * 模型服务的显示文字（状态栏、问答提示、概览生成弹窗共用），如“anthropic（claude-x）”；
 * 模型为空时显示“默认模型”，本机 CLI 额外说明用的是用户自己的订阅/账号额度。
 */
export function llmLabel(provider: string | null | undefined, model: string | null | undefined): string {
  const base = `${providerName(provider)}（${model || '默认模型'}）`;
  return isCliProvider(provider) ? `${base}（本机 CLI，使用你的订阅/账号额度）` : base;
}
