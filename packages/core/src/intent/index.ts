import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { completeWithLog, type LlmClient, type LlmMessage } from '../llm/index.js';
import { log } from '../log.js';
import type { IntentFinding, SymbolRef, Warning } from '../report/types.js';
import { parseIntentResponse, PROMPT_VERSION, retryPrompt, SYSTEM_PROMPT, userPrompt, type RawGroup } from './prompt.js';
import { buildStructureSummary, type IntentItem } from './summary.js';

export { buildStructureSummary, docFirstLine, estimateTokens, SUMMARY_TOKEN_BUDGET, type IntentItem, type StructureSummary } from './summary.js';
export { parseIntentResponse, PROMPT_VERSION, SYSTEM_PROMPT, type RawGroup } from './prompt.js';

const MAX_RESPONSE_TOKENS = 4096;

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
  /** 模型输出两次都不合格或请求失败时为 undefined */
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

/** 缓存 key = hash(模型名 + prompt 版本 + 意图文本 + 结构摘要) */
export function intentCacheKey(model: string, intentText: string, summary: string): string {
  return createHash('sha256').update([model, String(PROMPT_VERSION), intentText, summary].join('\u0000')).digest('hex');
}

async function readCache(file: string): Promise<RawGroup[] | undefined> {
  try {
    const entry = JSON.parse(await readFile(file, 'utf8')) as CacheEntry;
    return Array.isArray(entry.groups) ? entry.groups : undefined;
  } catch {
    return undefined;
  }
}

/** 先写临时文件再改名，并发进程不会读到写了一半的缓存 */
async function writeCache(file: string, entry: CacheEntry): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(entry));
  await rename(tmp, file);
}

type AskResult = { ok: true; groups: RawGroup[] } | { ok: false; warning: Warning };

/** 发送请求并校验输出；不合格时把原因告诉模型重试 1 次，仍不合格就放弃 */
async function askModel(client: LlmClient, prompt: string, items: number): Promise<AskResult> {
  const messages: LlmMessage[] = [{ role: 'user', content: prompt }];
  for (let attempt = 1; attempt <= 2; attempt++) {
    let reply: string;
    try {
      reply = await completeWithLog(client, { system: SYSTEM_PROMPT, messages, maxTokens: MAX_RESPONSE_TOKENS }, { items, attempt });
    } catch (err) {
      return { ok: false, warning: { code: 'llm_failed', level: 'warning', message: `intent check skipped: ${client.provider} request failed: ${(err as Error).message.split('\n')[0]}` } };
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

/** 核对模型返回的 key 和模块：不在改动清单里的丢弃；模块以组内符号所在模块为准，再并上模型给出的已知模块 */
function toFindings(groups: RawGroup[], input: IntentCheckInput, included: Set<string>): { findings: IntentFinding[]; droppedKeys: number } {
  const moduleOf = new Map(input.items.map((i) => [i.key, i.module]));
  const knownModules = new Set(input.items.filter((i) => included.has(i.key)).map((i) => i.module));
  let droppedKeys = 0;
  const findings: IntentFinding[] = [];
  for (const g of groups) {
    const keys = [...new Set(g.symbols)].filter((k) => included.has(k) && input.refs.has(k));
    droppedKeys += new Set(g.symbols).size - keys.length;
    const modules = new Set(keys.map((k) => moduleOf.get(k)!));
    for (const m of g.modules) if (knownModules.has(m)) modules.add(m);
    if (keys.length === 0 && modules.size === 0) continue;
    findings.push({ verdict: g.verdict, summary: g.summary, symbols: keys.map((k) => input.refs.get(k)!), modules: [...modules].sort() });
  }
  return { findings, droppedKeys };
}

type Groups = { ok: true; groups: RawGroup[]; cached: boolean } | { ok: false; warning: Warning };

/** 缓存命中直接用；否则提示后发送请求，合格的输出写入缓存 */
async function cachedOrAsk(input: IntentCheckInput, summaryText: string, items: number): Promise<Groups> {
  const { client } = input;
  const key = intentCacheKey(client.model, input.intentText, summaryText);
  const file = path.join(input.cacheDir, `${key}.json`);
  const hit = await readCache(file);
  if (hit) {
    log.info('llm_cache_hit', { provider: client.provider, model: client.model, items, key: key.slice(0, 16) });
    return { ok: true, groups: hit, cached: true };
  }
  log.info('llm_cache_miss', { provider: client.provider, model: client.model, items, key: key.slice(0, 16) });
  input.onBeforeSend?.();
  const asked = await askModel(client, userPrompt(input.intentText, summaryText), items);
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
 * 结果按 hash(模型 + prompt 版本 + 意图文本 + 摘要) 缓存在 llm-cache 目录。
 */
export async function runIntentCheck(input: IntentCheckInput): Promise<IntentCheckResult> {
  const summary = buildStructureSummary(input.items, input.addedFiles);
  const warnings = summary.truncatedModules.length > 0 ? [truncationWarning(summary.truncatedModules, summary.omittedSymbols)] : [];
  const got = await cachedOrAsk(input, summary.text, summary.includedKeys.size);
  if (!got.ok) return { warnings: [...warnings, got.warning], cached: false };
  const { groups, cached } = got;
  const items = summary.includedKeys.size;
  const { findings, droppedKeys } = toFindings(groups, input, summary.includedKeys);
  const counts = { mentioned: 0, unmentioned: 0, unclear: 0 };
  for (const f of findings) counts[f.verdict]++;
  log.info('intent_result', { model: input.client.model, cached, items, groups: findings.length, ...counts, droppedKeys, truncatedModules: summary.truncatedModules.length });
  return { findings, warnings, cached };
}
