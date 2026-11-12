import { log } from '../log.js';
import { overviewAiSetup, summarizeOptions, type OverviewOptions } from './ai-setup.js';
import { computeStructure } from './structure.js';
import { summarize } from './summarize.js';

export interface OverviewEstimate {
  modules: number;
  /** 需要发送的请求数（不含缓存命中） */
  llmCalls: number;
  cachedCalls: number;
  inputTokens: number;
  /** 按每次请求的输出上限估算 */
  outputTokens: number;
  provider: string | null;
  model: string | null;
  sendSource: boolean;
  /** 会发送请求（配置了 LLM 且不是 noLlm）且估算输入 token 超过 overview.confirmTokens，生成前要二次确认 */
  needsConfirm: boolean;
}

/**
 * 估算（第 10 步）：用和生成相同的流程拼出全部请求、查缓存，但不发送、不写库、不写划分记录。
 * 系统简介的输入依赖模块名称，有模块未命中时它也按需要请求计。
 */
export async function estimateOverview(opts: OverviewOptions): Promise<OverviewEstimate> {
  const setup = overviewAiSetup(opts);
  const s = await computeStructure(opts);
  const modules = structuredClone(s.modules);
  const r = await summarize(s, modules, { ...summarizeOptions(opts, setup), dryRun: true });
  const est: OverviewEstimate = {
    modules: modules.length, llmCalls: r.pending.calls, cachedCalls: r.ai.cached,
    inputTokens: r.pending.inputTokens, outputTokens: r.pending.outputTokens,
    provider: setup.provider ?? null, model: setup.model ?? null, sendSource: setup.sendSource,
    needsConfirm: setup.client !== undefined && r.pending.calls > 0 && r.pending.inputTokens > opts.config.overview.confirmTokens,
  };
  log.info('overview_estimated', { ...est });
  return est;
}
