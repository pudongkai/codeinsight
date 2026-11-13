import type { CodeInsightConfig } from '../config/index.js';
import { throwIfCancelled } from '../llm/index.js';
import { log } from '../log.js';
import { overviewAiSetup, summarizeOptions, type OverviewAiSetup, type OverviewOptions } from './ai-setup.js';
import { estimateOverview, type OverviewEstimate } from './estimate.js';
import { writePartitionRecord } from './partition-state.js';
import { computeStructure, structureReport } from './structure.js';
import { summarize, type SummarizeResult } from './summarize.js';
import type { OverviewReport } from './types.js';

export class OverviewRunningError extends Error {
  constructor(readonly runningId: number, readonly pid: number) {
    super(`an overview is already being generated (pid ${pid})`);
  }
}

/** 新建 running 记录；已有其他任务在运行时抛 OverviewRunningError */
export function beginOverview(opts: OverviewOptions, setup: OverviewAiSetup): number {
  const { snapshot } = opts;
  const r = opts.store.overviews.begin({
    ref: opts.ref, snapshotKind: snapshot.kind, commitSha: snapshot.commitSha, contentKey: snapshot.contentKey,
    params: {
      noLlm: Boolean(opts.noLlm), sendSource: setup.sendSource,
      ...(setup.provider ? { provider: setup.provider } : {}), ...(setup.model ? { model: setup.model } : {}), ...(setup.identity ? { llmIdentity: setup.identity } : {}),
    },
  });
  if (!r.ok) throw new OverviewRunningError(r.running.id, r.running.pid);
  return r.id;
}

/** 组装（第 11 步）：结构部分 + AI 结果 + 各处的提示 */
function assemble(report: OverviewReport, ai: SummarizeResult, setup: OverviewAiSetup, config: CodeInsightConfig): OverviewReport {
  report.features = ai.features;
  if (ai.system) report.system = ai.system;
  report.ai = ai.ai;
  if (ai.hasLlm && setup.provider && setup.model) report.llm = { provider: setup.provider, model: setup.model, sendSource: setup.sendSource };
  report.warnings = [...(config.warnings ?? []), ...report.warnings, ...setup.warnings, ...ai.warnings];
  return report;
}

/** 生成成功后写回划分记录；写失败不影响已保存的概览，下次生成会再写 */
async function savePartitionRecord(dataDir: string, s: Awaited<ReturnType<typeof computeStructure>>): Promise<void> {
  if (!s.partition.recordChanged) return;
  try {
    await writePartitionRecord(dataDir, s.partition.record);
  } catch {
    // writePartitionRecord 已记日志
  }
}

export interface OverviewResult {
  id: number;
  report: OverviewReport;
  hasLlm: boolean;
}

/**
 * 在已开始的记录上生成：结构部分 → AI 部分 → 写 overviews 表 → 写回划分记录；出错或被中止（LlmCancelledError）时
 * 记录改为 failed 并抛出，缺 AI 描述的结果不保存
 */
export async function generateOverview(id: number, opts: OverviewOptions, setup: OverviewAiSetup): Promise<OverviewResult> {
  const { store, config } = opts;
  const started = Date.now();
  try {
    store.overviews.setProgress(id, { step: 'partition' });
    const s = await computeStructure(opts);
    const report = structureReport(s, { repo: opts.repo, ref: opts.ref });
    const ai = await summarize(s, report.modules, { ...summarizeOptions(opts, setup), onProgress: (p) => store.overviews.setProgress(id, p) });
    throwIfCancelled(opts.signal, 'overview generation');
    assemble(report, ai, setup, config);
    store.overviews.finish(id, report, ai.hasLlm);
    await savePartitionRecord(config.dataDir, s);
    log.info('overview_generated', { id, modules: report.modules.length, ...report.ai, hasLlm: ai.hasLlm, ms: Date.now() - started });
    return { id, report, hasLlm: ai.hasLlm };
  } catch (err) {
    store.overviews.fail(id, (err as Error).message);
    throw err;
  }
}

export interface StartOverviewOptions {
  /** 用户已确认（CLI --yes、Web“仍然生成”）：超过阈值也开始 */
  confirmed?: boolean;
  /** confirmed 时也先估算（CLI 要在生成前提示请求数和 token） */
  alwaysEstimate?: boolean;
}

export type OverviewStart =
  | { kind: 'needs_confirm'; estimate: OverviewEstimate }
  | { kind: 'started'; id: number; estimate?: OverviewEstimate; generate: () => Promise<OverviewResult> };

/**
 * 生成前的共同流程（CLI、serve 共用）：未确认时先估算，超过 confirmTokens 返回 needs_confirm；
 * 否则新建 running 记录（其他任务在运行时抛 OverviewRunningError），返回记录 id 和执行生成的函数。
 */
export async function startOverview(opts: OverviewOptions, start: StartOverviewOptions = {}): Promise<OverviewStart> {
  const estimate = !start.confirmed || start.alwaysEstimate ? await estimateOverview(opts) : undefined;
  if (estimate?.needsConfirm && !start.confirmed) {
    log.info('overview_needs_confirm', { inputTokens: estimate.inputTokens, llmCalls: estimate.llmCalls });
    return { kind: 'needs_confirm', estimate };
  }
  const setup = overviewAiSetup(opts);
  const id = beginOverview(opts, setup);
  return { kind: 'started', id, ...(estimate ? { estimate } : {}), generate: () => generateOverview(id, opts, setup) };
}

/** 不经确认直接生成并等它完成（测试、脚本用）；走 startOverview 同一流程 */
export async function runOverview(opts: OverviewOptions): Promise<OverviewResult> {
  const start = await startOverview(opts, { confirmed: true });
  if (start.kind === 'needs_confirm') throw new Error('unexpected needs_confirm for a confirmed overview');
  return start.generate();
}
