import type { CodeInsightConfig } from '../config/index.js';
import { log } from '../log.js';
import type { Warning } from '../report/types.js';
import { createLlmClient, type LlmClient } from './index.js';

export type LlmClientResult = { client: LlmClient } | { warning: Warning };

/**
 * 按配置创建客户端：传入了客户端（测试注入）直接用；没有配置 LLM 时返回 undefined；
 * 配置有误或缺少 key 时转成 `llm_not_configured`，message 以 skipped 开头（如 "intent check skipped"）。
 */
export function llmClientFromConfig(config: Pick<CodeInsightConfig, 'llm' | 'llmProblem'>, opts: { client?: LlmClient; skipped: string }): LlmClientResult | undefined {
  if (opts.client) return { client: opts.client };
  if (config.llmProblem) {
    return { warning: { code: 'llm_not_configured', level: 'warning', message: `${opts.skipped}: invalid LLM configuration: ${config.llmProblem}` } };
  }
  if (!config.llm) return undefined;
  try {
    return { client: createLlmClient(config.llm) };
  } catch (err) {
    return { warning: { code: 'llm_not_configured', level: 'info', message: `${opts.skipped}: ${(err as Error).message}` } };
  }
}

/** 已提示过的 provider + 模型 + 提示文字；发送内容不同的功能（审查只发结构摘要、概览可能带源码）各提示一次 */
const noticed = new Set<string>();

/**
 * 第一次实际发送前提示一次，写明会发到哪个 provider 和模型。message 由调用方给出（发送的内容各功能不同）；
 * 没有 onNotice 时只记日志。
 */
export function notifyLlmOnce(client: Pick<LlmClient, 'provider' | 'model'>, message: string, onNotice?: (message: string) => void): void {
  const id = [client.provider, client.model, message].join('\0');
  if (noticed.has(id)) return;
  noticed.add(id);
  if (onNotice) onNotice(message);
  else log.info('llm_notice', { provider: client.provider, model: client.model });
}
