import { estimateTokens } from '../intent/summary.js';
import { askJson, jsonRetryPrompt } from '../llm/ask-json.js';
import { llmCacheKey, readLlmCache, writeLlmCache } from '../llm/cache.js';
import type { LlmClient } from '../llm/index.js';
import { notifyLlmOnce } from '../llm/setup.js';
import { log } from '../log.js';
import type { Warning } from '../report/types.js';
import type { OverviewProgress } from '../store/overviews.js';
import { pushTo } from '../util/collections.js';
import { mapPool } from '../util/pool.js';
import { applyFeatureNames } from './features.js';
import { moduleTopDir } from './module-id.js';
import type { OverviewStructure } from './structure.js';
import {
  aiPrompt, entryCalls, featureRequest, moduleRequest, OUTPUT_TOKENS, OVERVIEW_PROMPT_VERSION, OVERVIEW_SYSTEM_PROMPT,
  parseReply, promptTokens, README_CHARS, SYSTEM_GROUP_THRESHOLD, systemEdges, systemModuleLines, systemRequest,
  type AiRequest, type ModuleSummary, type SystemInput, type SystemSummary,
} from './summarize-input.js';
import type { Feature, OverviewAiStats, OverviewModule, OverviewReport } from './types.js';
import { compareStrings } from '../util/compare.js';

export interface SummarizeOptions {
  /** 发送请求用；没有时只查缓存（noLlm 或未配置 LLM） */
  client?: LlmClient;
  /** 缓存身份 llmIdentity；没有时全部按未命中处理 */
  identity?: string;
  cacheDir: string;
  language: string;
  sendSource: boolean;
  concurrency: number;
  /** 估算：查缓存，未命中的请求只计数（有 client 时），不发送 */
  dryRun?: boolean;
  /** 上一次带 AI 说明的概览，稳定命名用；不影响缓存 key */
  previous?: OverviewReport;
  /** 读快照里的文件（README） */
  readFile: (path: string) => Promise<string>;
  onLlmNotice?: (message: string) => void;
  onProgress?: (p: OverviewProgress) => void;
}

/** 估算时未命中缓存、需要发送的请求 */
export interface PendingCalls {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface SummarizeResult {
  /** 填上名称、职责和 aiStatus 后的模块（传入的数组本身） */
  modules: OverviewModule[];
  features: Feature[];
  system?: SystemSummary;
  ai: OverviewAiStats;
  pending: PendingCalls;
  warnings: Warning[];
  /** 至少一个模块、功能或系统简介有 LLM 生成的内容（本次请求或缓存命中） */
  hasLlm: boolean;
}

type Outcome<T> = { status: 'ok' | 'cached'; value: T } | { status: 'failed' | 'skipped' | 'none' };

/** 失败数不少于这个数且超过已发送请求的一半时停止后续请求 */
export const ABORT_MIN_FAILED = 5;
const SYSTEM_TARGET = '*system*';

interface Run {
  opts: SummarizeOptions;
  ai: OverviewAiStats;
  pending: PendingCalls;
  aborted: boolean;
  /** 发送失败的请求：kind:target */
  failedTargets: string[];
}

function hasValue<T>(o: Outcome<T>): o is { status: 'ok' | 'cached'; value: T } {
  return o.status === 'ok' || o.status === 'cached';
}

function cacheKeyOf(opts: SummarizeOptions, req: AiRequest<unknown>): string {
  return llmCacheKey([opts.identity!, String(OVERVIEW_PROMPT_VERSION), req.kind, opts.language, req.input]);
}

function noticeText(client: LlmClient, sendSource: boolean): string {
  return `sending structural information${sendSource ? ' and source snippets' : ' (no source code)'} to ${client.provider} (${client.model}) to generate the overview`;
}

/** 缓存命中直接用；未命中时按模式计数（估算）、不发（没有客户端）、跳过（已停止）或发送 */
async function runRequest<T>(run: Run, req: AiRequest<T>, previous?: string): Promise<Outcome<T>> {
  const { opts } = run;
  const key = opts.identity ? cacheKeyOf(opts, req) : undefined;
  if (key) {
    const pick = (e: unknown) => {
      const r = req.validate((e as { value?: unknown } | null)?.value);
      return r.ok ? r.value : undefined;
    };
    const hit = await readLlmCache(opts.cacheDir, key, pick, { kind: req.kind, target: req.target });
    if (hit !== undefined) {
      run.ai.cached++;
      return { status: 'cached', value: hit };
    }
  }
  if (!opts.client) return { status: 'none' };
  const prompt = aiPrompt(req, opts.language, previous);
  if (opts.dryRun) {
    run.pending.calls++;
    run.pending.inputTokens += promptTokens(prompt);
    run.pending.outputTokens += OUTPUT_TOKENS[req.kind];
    return { status: 'none' };
  }
  if (run.aborted) return { status: 'skipped' };
  return send(run, opts.client, req, prompt, key);
}

async function send<T>(run: Run, client: LlmClient, req: AiRequest<T>, prompt: string, key: string | undefined): Promise<Outcome<T>> {
  notifyLlmOnce(client, noticeText(client, run.opts.sendSource), run.opts.onLlmNotice);
  const r = await askJson({
    client, system: OVERVIEW_SYSTEM_PROMPT, prompt, maxTokens: OUTPUT_TOKENS[req.kind], items: 1,
    parse: (reply) => parseReply(req, reply), retryPrompt: jsonRetryPrompt, transientRetries: 2, invalidEvent: 'overview_response_invalid',
  });
  run.ai.calls++;
  run.ai.inputTokens += promptTokens(prompt);
  if (r.ok) {
    run.ai.outputTokens += estimateTokens(JSON.stringify(r.value));
    if (key) await writeLlmCache(run.opts.cacheDir, key, { kind: req.kind, promptVersion: OVERVIEW_PROMPT_VERSION, createdAt: Date.now(), value: r.value });
    log.info('overview_ai_done', { kind: req.kind, target: req.target, truncatedInput: req.truncated });
    return { status: 'ok', value: r.value };
  }
  run.ai.failed++;
  run.failedTargets.push(`${req.kind}:${req.target}`);
  log.warn('overview_ai_failed', { kind: req.kind, target: req.target, failure: r.failure, error: r.failure === 'invalid' ? r.reason : r.error.message.split('\n')[0] });
  if (!run.aborted && run.ai.failed >= ABORT_MIN_FAILED && run.ai.failed * 2 > run.ai.calls) {
    run.aborted = true;
    log.warn('overview_ai_aborted', { failed: run.ai.failed, calls: run.ai.calls });
  }
  return { status: 'failed' };
}

// ---------- 稳定命名：上一次的名称附在提示里 ----------

const NAMED_STATUS = new Set(['ok', 'cached', 'truncated']);

function moduleHint(previous: OverviewReport | undefined, id: string): string | undefined {
  const m = previous?.modules.find((x) => x.id === id);
  if (!m || !NAMED_STATUS.has(m.aiStatus)) return undefined;
  return `The previous name of this module was "${m.name}". Keep it unless the module's responsibility has clearly changed.`;
}

function featureHint(previous: OverviewReport | undefined, id: string): string | undefined {
  const m = previous?.modules.find((x) => x.id === id);
  const names = previous?.features.filter((f) => f.module === id).map((f) => `"${f.name}"`) ?? [];
  if (!m || !NAMED_STATUS.has(m.aiStatus) || names.length === 0) return undefined;
  return `Previous feature names of this module: ${names.join(', ')}. Reuse them for features that have not clearly changed.`;
}

function systemHint(previous: OverviewReport | undefined): string | undefined {
  return previous?.system ? `The previous title was "${previous.system.title}". Keep it unless the system has clearly changed.` : undefined;
}

// ---------- 三类请求 ----------

function progress(run: Run, step: string, done?: number, total?: number): void {
  run.opts.onProgress?.({ step, ...(done !== undefined ? { done, total } : {}) });
}

function applyModule(m: OverviewModule, out: Outcome<ModuleSummary>, truncated: boolean): void {
  if (!hasValue(out)) {
    m.aiStatus = out.status;
    return;
  }
  const v = out.value;
  m.name = v.name;
  if (v.responsibility) m.responsibility = v.responsibility;
  const iface = new Map(v.interfaces.map((x) => [x.key, x.summary]));
  const model = new Map(v.models.map((x) => [x.key, x.summary]));
  for (const i of m.interfaces) if (iface.has(i.symbol.key)) i.summary = iface.get(i.symbol.key);
  for (const x of m.models) if (model.has(x.symbol.key)) x.summary = model.get(x.symbol.key);
  m.aiStatus = out.status === 'ok' && truncated ? 'truncated' : out.status;
}

async function summarizeModules(run: Run, s: OverviewStructure, modules: OverviewModule[]): Promise<string[]> {
  const reqs = modules.map((m) => moduleRequest(s, m, run.opts.sendSource));
  let done = 0;
  progress(run, 'modules', 0, modules.length);
  await mapPool(modules, run.opts.concurrency, async (m, i) => {
    applyModule(m, await runRequest(run, reqs[i]!, moduleHint(run.opts.previous, m.id)), reqs[i]!.truncated);
    progress(run, 'modules', ++done, modules.length);
  });
  return reqs.filter((r) => r.truncated).map((r) => r.target);
}

/** 功能命名：每个有入口的模块一次；没有结果的模块用默认分组 */
async function nameFeatures(run: Run, s: OverviewStructure): Promise<{ features: Feature[]; named: number }> {
  const byModule = new Map<string, Feature[]>();
  for (const f of s.features) pushTo(byModule, f.module, f);
  const groups = [...byModule];
  const calls = entryCalls(s.graph);
  let done = 0;
  let named = 0;
  progress(run, 'features', 0, groups.length);
  const results = await mapPool(groups, run.opts.concurrency, async ([module, defaults]) => {
    const out = await runRequest(run, featureRequest(s.graph, calls, module, defaults), featureHint(run.opts.previous, module));
    progress(run, 'features', ++done, groups.length);
    if (!hasValue(out)) return defaults;
    named++;
    return applyFeatureNames(module, defaults, out.value.features);
  });
  return { features: structuredClone(results.flat()), named };
}

async function readReadme(read: (p: string) => Promise<string>): Promise<string | undefined> {
  try {
    const text = (await read('README.md')).slice(0, README_CHARS).trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

/** 模块超过 SYSTEM_GROUP_THRESHOLD 个时：按顶层目录分组各请求一次组摘要；有组失败时返回 undefined */
async function groupSummaries(run: Run, s: OverviewStructure, base: Omit<SystemInput, 'task'>): Promise<SystemInput['groups']> {
  const byDir = new Map<string, NonNullable<SystemInput['modules']>>();
  for (const m of base.modules!) pushTo(byDir, moduleTopDir(m.id), m);
  const dirs = [...byDir].sort(([a], [b]) => compareStrings(a, b));
  const outs = await mapPool(dirs, run.opts.concurrency, ([dir, lines]) => runRequest(run, systemRequest('system_group', dir, {
    task: 'group_summary', group: dir, modules: lines, edges: systemEdges(s, new Set(lines.map((l) => l.id))),
  })));
  if (outs.some((o) => o.status === 'failed' || o.status === 'skipped')) return undefined;
  return dirs.map(([dir], i) => {
    const o = outs[i]!;
    return hasValue(o) ? { group: dir, ...o.value } : { group: dir, title: dir, summary: '' };
  });
}

/** 系统简介：汇总各模块的名称和职责；模块多时先分组 */
async function summarizeSystem(run: Run, s: OverviewStructure, modules: OverviewModule[]): Promise<Outcome<SystemSummary>> {
  progress(run, 'system');
  const readme = await readReadme(run.opts.readFile);
  const base = {
    modules: systemModuleLines(modules),
    edges: systemEdges(s),
    external: s.external.map((e) => ({ category: e.category, libs: e.libs })),
    ...(readme ? { readme } : {}),
  };
  let input: SystemInput = { task: 'system_summary', ...base };
  if (modules.length > SYSTEM_GROUP_THRESHOLD) {
    const groups = await groupSummaries(run, s, base);
    if (!groups) return { status: 'failed' };
    input = { task: 'system_summary', groups, edges: base.edges, external: base.external, ...(readme ? { readme } : {}) };
  }
  return runRequest(run, systemRequest('system', SYSTEM_TARGET, input), systemHint(run.opts.previous));
}

// ---------- 汇总 ----------

function aiWarnings(run: Run, modules: OverviewModule[], truncated: string[], system: Outcome<SystemSummary>): Warning[] {
  const out: Warning[] = [];
  if (run.aborted) {
    const skipped = modules.filter((m) => m.aiStatus === 'skipped').length;
    out.push({ code: 'llm_aborted', level: 'warning', message: `stopped sending AI requests after ${run.ai.failed} of ${run.ai.calls} failed (check the API key, quota or service); ${skipped} module(s) skipped` });
  } else if (run.ai.failed > 0) {
    out.push({ code: 'llm_failed', level: 'warning', message: `${run.ai.failed} AI request(s) failed: ${run.failedTargets.join(', ')}` });
  }
  if (truncated.length > 0) {
    out.push({ code: 'overview_input_truncated', level: 'info', message: `module input exceeded the token budget and was shortened: ${truncated.join(', ')}` });
  }
  if (system.status === 'failed' || system.status === 'skipped') {
    out.push({ code: 'overview_system_failed', level: 'warning', message: 'the system introduction could not be generated' });
  }
  return out;
}

/**
 * AI 部分（第 9 步）：模块摘要 → 功能命名 → 系统简介。每个请求先查缓存；没有客户端时只查缓存；
 * dryRun 时未命中的只计数。失败的请求超过一半且不少于 5 个时停止后续请求，剩余的记 skipped。
 * modules 是可修改的副本（如 structureReport 的结果），名称、职责和 aiStatus 直接写在上面。
 */
export async function summarize(s: OverviewStructure, modules: OverviewModule[], opts: SummarizeOptions): Promise<SummarizeResult> {
  const run: Run = {
    opts, ai: { calls: 0, cached: 0, failed: 0, inputTokens: 0, outputTokens: 0 }, pending: { calls: 0, inputTokens: 0, outputTokens: 0 },
    aborted: false, failedTargets: [],
  };
  const truncated = await summarizeModules(run, s, modules);
  const { features, named } = await nameFeatures(run, s);
  const system = await summarizeSystem(run, s, modules);
  const hasLlm = modules.some((m) => NAMED_STATUS.has(m.aiStatus)) || named > 0 || hasValue(system);
  log.info('overview_ai_summary', { ...run.ai, aborted: run.aborted, dryRun: Boolean(opts.dryRun), pending: run.pending.calls, hasLlm });
  return {
    modules, features, ...(hasValue(system) ? { system: system.value } : {}),
    ai: run.ai, pending: run.pending, warnings: opts.dryRun ? [] : aiWarnings(run, modules, truncated, system), hasLlm,
  };
}
