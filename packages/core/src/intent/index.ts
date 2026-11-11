import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { completeWithLog, LlmTruncatedError, type LlmClient, type LlmMessage } from '../llm/index.js';
import { log } from '../log.js';
import type { IntentFinding, SymbolRef, Warning } from '../report/types.js';
import { parseIntentResponse, PROMPT_VERSION, retryPrompt, SYSTEM_PROMPT, userPrompt, type RawGroup } from './prompt.js';
import { buildStructureSummary, estimateTokens, type IntentItem } from './summary.js';

export { buildStructureSummary, docFirstLine, estimateTokens, SUMMARY_TOKEN_BUDGET, type IntentItem, type StructureSummary } from './summary.js';
export { parseIntentResponse, PROMPT_VERSION, SYSTEM_PROMPT, type RawGroup } from './prompt.js';

/** 输出上限的下限；上限默认值见 DEFAULT_MAX_OUTPUT_TOKENS，中间按摘要里的符号数估算 */
export const MIN_RESPONSE_TOKENS = 1024;
/** 很多 openai-compatible 模型的输出上限是 4096 或 8192，超出会被服务端直接拒绝，默认取 8192 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
export const MAX_OUTPUT_TOKENS_ENV = 'CODEINSIGHT_LLM_MAX_OUTPUT_TOKENS';
/** 每个符号除 key 本身外的输出余量：引号、逗号，以及最坏情况下自成一组时的 verdict、summary 和模块名 */
const TOKENS_PER_SYMBOL = 48;

/** 输出 token 的最终上限：取环境变量 CODEINSIGHT_LLM_MAX_OUTPUT_TOKENS，不是正整数时忽略并用默认值 */
export function maxOutputTokens(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MAX_OUTPUT_TOKENS_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_OUTPUT_TOKENS;
  const n = Number(raw);
  if (Number.isSafeInteger(n) && n > 0) return n;
  log.warn('llm_max_output_tokens_invalid', { value: raw, fallback: DEFAULT_MAX_OUTPUT_TOKENS });
  return DEFAULT_MAX_OUTPUT_TOKENS;
}

/** 按要分组的符号估算输出上限：每个 key 在回复里原样出现一次，再加上分组的开销；不超过 cap */
export function responseTokenLimit(keys: Iterable<string>, cap: number = maxOutputTokens()): number {
  let need = MIN_RESPONSE_TOKENS;
  for (const k of keys) need += estimateTokens(k) + TOKENS_PER_SYMBOL;
  return Math.min(need, cap);
}

export interface IntentCheckInput {
  intentText: string;
  items: IntentItem[];
  addedFiles: string[];
  /** 改动符号 key → 报告里的引用；模型返回的 key 不在这里的丢弃 */
  refs: Map<string, SymbolRef>;
  client: LlmClient;
  /** `<dataDir>/llm-cache` */
  cacheDir: string;
  /** 实际发送请求前调用一次（缓存命中时不调用），CLI 用它提示将发送结构摘要 */
  onBeforeSend?: () => void;
}

export interface IntentCheckResult {
  /** 跳过检查、请求失败、回复被截断或两次都不合格时为 undefined */
  findings?: IntentFinding[];
  warnings: Warning[];
  cached: boolean;
}

interface CacheEntry {
  model: string;
  promptVersion: number;
  createdAt: number;
  groups: RawGroup[];
}

/** 缓存 key = hash(provider + 请求地址 + 模型名 + prompt 版本 + 意图文本 + 结构摘要)；同名模型在不同服务上的结果不混用 */
export function intentCacheKey(client: Pick<LlmClient, 'provider' | 'model' | 'baseUrl'>, intentText: string, summary: string): string {
  const parts = [client.provider, client.baseUrl ?? '', client.model, String(PROMPT_VERSION), intentText, summary];
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

async function readCache(file: string): Promise<RawGroup[] | undefined> {
  try {
    const entry = JSON.parse(await readFile(file, 'utf8')) as CacheEntry;
    return Array.isArray(entry.groups) ? entry.groups : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 先写临时文件再改名，并发的读方不会读到写了一半的缓存；临时文件名带随机部分，同一进程里并发写同一个 key 也不冲突。
 * 缓存只是加速，写失败（目录只读、磁盘满）只记日志，不影响本次结果。
 */
async function writeCache(file: string, entry: CacheEntry): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(tmp, JSON.stringify(entry));
    await rename(tmp, file);
  } catch (err) {
    log.warn('llm_cache_write_failed', { file: path.basename(file), error: (err as Error).message.split('\n')[0] });
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

type AskResult = { ok: true; groups: RawGroup[] } | { ok: false; warning: Warning };

function requestFailure(client: LlmClient, err: unknown): AskResult {
  if (err instanceof LlmTruncatedError) {
    const message = `intent check skipped: the model reply was cut off at ${err.maxTokens} output tokens; split the change into smaller reviews, or raise ${MAX_OUTPUT_TOKENS_ENV} if the model allows longer replies`;
    return { ok: false, warning: { code: 'llm_truncated', level: 'warning', message } };
  }
  return { ok: false, warning: { code: 'llm_failed', level: 'warning', message: `intent check skipped: ${client.provider} request failed: ${(err as Error).message.split('\n')[0]}` } };
}

/** 发送请求并校验输出；不合格时把原因告诉模型重试 1 次，仍不合格就放弃。请求失败和回复被截断都不重试 */
async function askModel(client: LlmClient, prompt: string, keys: Set<string>): Promise<AskResult> {
  const messages: LlmMessage[] = [{ role: 'user', content: prompt }];
  const maxTokens = responseTokenLimit(keys);
  const items = keys.size;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let reply: string;
    try {
      reply = await completeWithLog(client, { system: SYSTEM_PROMPT, messages, maxTokens }, { items, attempt });
    } catch (err) {
      return requestFailure(client, err);
    }
    const parsed = parseIntentResponse(reply);
    if (parsed.ok) return parsed;
    log.warn('intent_response_invalid', { model: client.model, attempt, reason: parsed.reason });
    if (attempt === 2) {
      return { ok: false, warning: { code: 'llm_invalid_response', level: 'warning', message: `intent check skipped: the model reply was invalid twice (${parsed.reason})` } };
    }
    messages.push({ role: 'assistant', content: reply }, { role: 'user', content: retryPrompt(parsed.reason) });
  }
  throw new Error('unreachable');
}

/** 模型漏掉的符号归到这一组，不悄悄丢掉 */
export const UNGROUPED_SUMMARY = 'Changes the model did not assign to any group';

interface FindingStats {
  droppedKeys: number;
  duplicateKeys: number;
  ungroupedKeys: number;
}

/**
 * 核对模型返回的 key 和模块：不在改动清单里的丢弃；同一个 key 出现在多组时只留第一组；
 * 摘要里有、模型没分到任何组的 key 归入一个 unclear 组。模块以组内符号所在模块为准，再并上模型给出的已知模块。
 */
function toFindings(groups: RawGroup[], input: IntentCheckInput, included: Set<string>): { findings: IntentFinding[]; stats: FindingStats } {
  const moduleOf = new Map(input.items.map((i) => [i.key, i.module]));
  const knownModules = new Set(input.items.filter((i) => included.has(i.key)).map((i) => i.module));
  const valid = (k: string) => included.has(k) && input.refs.has(k);
  const seen = new Set<string>();
  const stats: FindingStats = { droppedKeys: 0, duplicateKeys: 0, ungroupedKeys: 0 };
  const finding = (verdict: IntentFinding['verdict'], summary: string, keys: string[], modules: Set<string>): IntentFinding =>
    ({ verdict, summary, symbols: keys.map((k) => input.refs.get(k)!), modules: [...modules].sort() });
  const findings: IntentFinding[] = [];
  for (const g of groups) {
    const unique = [...new Set(g.symbols)];
    stats.droppedKeys += unique.filter((k) => !valid(k)).length;
    const keys = unique.filter((k) => valid(k) && !seen.has(k));
    stats.duplicateKeys += unique.filter((k) => valid(k) && seen.has(k)).length;
    for (const k of keys) seen.add(k);
    const modules = new Set(keys.map((k) => moduleOf.get(k)!));
    for (const m of g.modules) if (knownModules.has(m)) modules.add(m);
    if (keys.length === 0 && modules.size === 0) continue;
    findings.push(finding(g.verdict, g.summary, keys, modules));
  }
  const ungrouped = [...included].filter((k) => input.refs.has(k) && !seen.has(k)).sort();
  stats.ungroupedKeys = ungrouped.length;
  if (ungrouped.length > 0) findings.push(finding('unclear', UNGROUPED_SUMMARY, ungrouped, new Set(ungrouped.map((k) => moduleOf.get(k)!))));
  return { findings, stats };
}

type Groups = { ok: true; groups: RawGroup[]; cached: boolean } | { ok: false; warning: Warning };

/** 缓存命中直接用；否则提示后发送请求，合格的输出写入缓存 */
async function cachedOrAsk(input: IntentCheckInput, summaryText: string, keys: Set<string>): Promise<Groups> {
  const { client } = input;
  const items = keys.size;
  const key = intentCacheKey(client, input.intentText, summaryText);
  const file = path.join(input.cacheDir, `${key}.json`);
  const hit = await readCache(file);
  if (hit) {
    log.info('llm_cache_hit', { provider: client.provider, model: client.model, items, key: key.slice(0, 16) });
    return { ok: true, groups: hit, cached: true };
  }
  log.info('llm_cache_miss', { provider: client.provider, model: client.model, items, key: key.slice(0, 16) });
  input.onBeforeSend?.();
  const asked = await askModel(client, userPrompt(input.intentText, summaryText), keys);
  if (!asked.ok) return asked;
  await writeCache(file, { model: client.model, promptVersion: PROMPT_VERSION, createdAt: Date.now(), groups: asked.groups });
  return { ok: true, groups: asked.groups, cached: false };
}

function truncationWarning(modules: string[], omitted: number): Warning {
  return {
    code: 'intent_truncated', level: 'warning',
    message: `structural summary exceeded the token budget; ${omitted} symbol(s) in ${modules.length} module(s) were not sent to the LLM: ${modules.join(', ')}`,
  };
}

/**
 * 意图偏离检测（review 第 9 步）：把结构摘要和意图文本发给 LLM，按 JSON 校验输出，
 * 结果按 hash(provider + 请求地址 + 模型 + prompt 版本 + 意图文本 + 摘要) 缓存在 llm-cache 目录。
 * 摘要里没有改动符号时不发请求。
 */
export async function runIntentCheck(input: IntentCheckInput): Promise<IntentCheckResult> {
  const summary = buildStructureSummary(input.items, input.addedFiles);
  const warnings = summary.truncatedModules.length > 0 ? [truncationWarning(summary.truncatedModules, summary.omittedSymbols)] : [];
  const items = summary.includedKeys.size;
  if (items === 0) {
    log.info('intent_skipped', { reason: 'no_changed_symbols' });
    return { warnings: [...warnings, { code: 'intent_no_symbols', level: 'info', message: 'intent check skipped: no changed functions, classes or modules to check' }], cached: false };
  }
  const got = await cachedOrAsk(input, summary.text, summary.includedKeys);
  if (!got.ok) return { warnings: [...warnings, got.warning], cached: false };
  const { groups, cached } = got;
  const { findings, stats } = toFindings(groups, input, summary.includedKeys);
  const counts = { mentioned: 0, unmentioned: 0, unclear: 0 };
  for (const f of findings) counts[f.verdict]++;
  log.info('intent_result', { model: input.client.model, cached, items, groups: findings.length, ...counts, ...stats, truncatedModules: summary.truncatedModules.length });
  return { findings, warnings, cached };
}
