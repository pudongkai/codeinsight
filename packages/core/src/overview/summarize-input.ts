import { docFirstLine, estimateTokens } from '../intent/summary.js';
import { isStringArray, parseJsonReply, type JsonParseResult } from '../llm/ask-json.js';
import { entryText, isHttpApi } from '../model/entry.js';
import type { SymbolRow } from '../model/types.js';
import { addToSet, pushTo } from '../util/collections.js';
import { moduleOfSymbol, type OverviewGraph } from './facts.js';
import type { NamedFeature } from './features.js';
import type { Snippet } from './snippets.js';
import type { OverviewStructure } from './structure.js';
import type { Feature, OverviewModule } from './types.js';
import { compareStrings } from '../util/compare.js';

/** prompt、输入字段或输出格式变化时加一，旧缓存随之失效 */
export const OVERVIEW_PROMPT_VERSION = 1;
/** 模块摘要输入里最多的公开符号数 */
export const MAX_PUBLIC_SYMBOLS = 60;
/** 模块摘要输入里本模块调出去的符号 key 最多个数 */
export const MAX_CALLED_KEYS = 40;
/** 功能命名输入里每个入口直接调用的符号 key 最多个数 */
export const MAX_ENTRY_CALLS = 8;
/** 系统简介输入里的模块依赖边最多条数（按 weight） */
export const MAX_SYSTEM_EDGES = 100;
export const README_CHARS = 4000;
/** 模块摘要输入超过这么多 token 时截断 */
export const MODULE_INPUT_TOKENS = 8000;
/** 模块超过这么多个时系统简介先按顶层目录分组摘要，再汇总 */
export const SYSTEM_GROUP_THRESHOLD = 60;

export type AiKind = 'module' | 'features' | 'system_group' | 'system';

/** 各类请求的输出上限，估算输出 token 时也按它算 */
export const OUTPUT_TOKENS: Record<AiKind, number> = { module: 2000, features: 2000, system_group: 1200, system: 2000 };

export const OVERVIEW_SYSTEM_PROMPT = `You describe the architecture of a codebase for engineers who are new to it.
You get structural facts extracted from the code (symbol keys, signatures, docstring first lines, dependencies,
and sometimes short source snippets). Line numbers are never included.
Reply with JSON only, no prose and no code fences, in exactly the shape given in the instructions.
Copy symbol keys exactly as listed and only use keys that appear in the input.`;

export interface ModuleSummaryInput {
  task: 'module_summary';
  module: string;
  dirs: string[];
  files: string[];
  size: number;
  symbols: { key: string; signature: string; doc?: string; method?: string; path?: string }[];
  models: { key: string; head?: string }[];
  calls: { module: string; keys: string[] }[];
  external: { category: string; libs: string[] }[];
  envVars: string[];
  snippets?: Snippet[];
}

export interface FeatureNamingInput {
  task: 'feature_naming';
  module: string;
  groups: { name: string; entries: { key: string; kind: string; method?: string; path?: string; doc?: string; calls: string[] }[] }[];
}

export interface SystemModuleLine {
  id: string;
  name: string;
  responsibility?: string;
  size: number;
  httpApis: number;
}

export interface SystemInput {
  task: 'system_summary' | 'group_summary';
  group?: string;
  modules?: SystemModuleLine[];
  groups?: { group: string; title: string; summary: string }[];
  edges: { from: string; to: string; weight: number }[];
  external?: { category: string; libs: string[] }[];
  readme?: string;
}

export interface ModuleSummary {
  name: string;
  responsibility: string;
  interfaces: { key: string; summary: string }[];
  models: { key: string; summary: string }[];
}

export interface SystemSummary {
  title: string;
  summary: string;
}

/** 一次 AI 请求：input 是进缓存 key 的输入（JSON 文本）；上一次的名称另外附在提示里，不进 input */
export interface AiRequest<T> {
  kind: AiKind;
  /** 模块 id、功能所在模块 id、顶层目录名或 `*system*` */
  target: string;
  input: string;
  /** 输入是否被截断过（只有模块摘要会截断） */
  truncated: boolean;
  /** 校验 JSON 回复（也用于校验缓存里的值） */
  validate: (value: unknown) => JsonParseResult<T>;
  /** 回复的 JSON Schema，和 validate 对应；支持结构化输出的客户端按它约束回复 */
  jsonSchema: Record<string, unknown>;
}

const STRING = { type: 'string' };
const KEY_SUMMARY_LIST = { type: 'array', items: { type: 'object', properties: { key: STRING, summary: STRING }, required: ['key', 'summary'] } };

/** 各类回复的 JSON Schema，和 validateModule、validateFeatures、validateSystem 对应 */
export const OVERVIEW_JSON_SCHEMAS: Record<AiKind, Record<string, unknown>> = {
  module: {
    type: 'object',
    properties: { name: STRING, responsibility: STRING, interfaces: KEY_SUMMARY_LIST, models: KEY_SUMMARY_LIST },
    required: ['name', 'responsibility', 'interfaces', 'models'],
  },
  features: {
    type: 'object',
    properties: {
      features: {
        type: 'array',
        items: { type: 'object', properties: { name: STRING, description: STRING, entryKeys: { type: 'array', items: STRING } }, required: ['name', 'entryKeys'] },
      },
    },
    required: ['features'],
  },
  system_group: { type: 'object', properties: { title: STRING, summary: STRING }, required: ['title', 'summary'] },
  system: { type: 'object', properties: { title: STRING, summary: STRING }, required: ['title', 'summary'] },
};

const INSTRUCTIONS: Record<AiKind, string> = {
  module: `Describe this module. Shape:
{"name":"short module name","responsibility":"1-3 sentences on what it is responsible for","interfaces":[{"key":"<key from symbols>","summary":"one sentence"}],"models":[{"key":"<key from models>","summary":"one sentence"}]}
List the most important interfaces and models only.`,
  features: `Name the user-facing features of this module from its entry points. The given groups are a default grouping;
you may merge or split them. Shape:
{"features":[{"name":"short feature name","description":"one sentence","entryKeys":["<entry key>"]}]}
Put every entry key in exactly one feature.`,
  system_group: `Summarize this group of modules. Shape:
{"title":"short title","summary":"2-5 sentences"}`,
  system: `Write a short introduction to the whole system: what it does, its main parts and how they work together. Shape:
{"title":"system title","summary":"300-800 characters"}`,
};

/** 发送的提示：任务说明 + 语言 + 输入，上一次的名称（如果有）附在最后 */
export function aiPrompt(req: AiRequest<unknown>, language: string, previous?: string): string {
  const parts = [INSTRUCTIONS[req.kind], `Write names and descriptions in this language: ${language}.`, `Input:\n${req.input}`];
  if (previous) parts.push(previous);
  return parts.join('\n\n');
}

export function promptTokens(prompt: string): number {
  return estimateTokens(OVERVIEW_SYSTEM_PROMPT) + estimateTokens(prompt);
}

// ---------- 模块摘要 ----------

function symbolLine(g: OverviewGraph, s: SymbolRow): ModuleSummaryInput['symbols'][number] {
  const doc = docFirstLine(s.docstring);
  const e = g.entries.get(s.id);
  const http = isHttpApi(e) ? e : undefined;
  const method = http ? entryText(http, 'method') : '';
  const route = http ? entryText(http, 'path') : '';
  return { key: s.symbolKey, signature: s.displaySignature, ...(doc ? { doc } : {}), ...(method ? { method } : {}), ...(route ? { path: route } : {}) };
}

/** 本模块调出去的模块及被调用或引用的符号 key：按 key 排序取前 MAX_CALLED_KEYS 个，再按模块分组 */
function outgoingCalls(g: OverviewGraph, moduleId: string): ModuleSummaryInput['calls'] {
  const targets = new Map<string, string>();
  for (const e of g.links) {
    if (moduleOfSymbol(g, e.srcId) !== moduleId) continue;
    const to = moduleOfSymbol(g, e.dstId)!;
    if (to !== moduleId) targets.set(g.symbols.get(e.dstId)!.symbolKey, to);
  }
  const byModule = new Map<string, string[]>();
  for (const key of [...targets.keys()].sort().slice(0, MAX_CALLED_KEYS)) pushTo(byModule, targets.get(key)!, key);
  return [...byModule].sort(([a], [b]) => compareStrings(a, b)).map(([module, keys]) => ({ module, keys }));
}

/** 去掉列表最后一项，没有可去的返回 false */
function popLast(list: unknown[] | undefined): boolean {
  if (!list || list.length === 0) return false;
  list.pop();
  return true;
}

function popCall(calls: ModuleSummaryInput['calls']): boolean {
  const last = calls[calls.length - 1];
  if (!last) return false;
  last.keys.pop();
  if (last.keys.length === 0) calls.pop();
  return true;
}

/** 输入超过 MODULE_INPUT_TOKENS 时依次从末尾去掉：被调用符号 → 源码片段 → 模型 → 公开符号；返回是否截断过 */
export function fitModuleInput(input: ModuleSummaryInput, maxTokens = MODULE_INPUT_TOKENS): boolean {
  const steps = [() => popCall(input.calls), () => popLast(input.snippets), () => popLast(input.models), () => popLast(input.symbols)];
  let truncated = false;
  for (const step of steps) {
    while (estimateTokens(JSON.stringify(input)) > maxTokens && step()) truncated = true;
  }
  return truncated;
}

/** 模块摘要输入，只来自本模块的代码（排序和截断也只看本模块）；sendSource 为 false 时不带源码片段和模型类体 */
export function moduleInput(s: OverviewStructure, m: OverviewModule, sendSource: boolean): ModuleSummaryInput {
  const g = s.graph;
  const heads = new Map((s.modelHeads.get(m.id) ?? []).map((h) => [h.key, h.code]));
  const models = s.ownModels.get(m.id) ?? [];
  return {
    task: 'module_summary', module: m.id, dirs: m.dirs, files: m.files, size: m.size,
    symbols: (s.ranked.get(m.id) ?? []).slice(0, MAX_PUBLIC_SYMBOLS).map((x) => symbolLine(g, x)),
    models: models.map((x) => ({ key: x.symbolKey, ...(sendSource && heads.has(x.symbolKey) ? { head: heads.get(x.symbolKey)! } : {}) })),
    calls: outgoingCalls(g, m.id),
    external: m.external.map((e) => ({ category: e.category, libs: e.libs })),
    envVars: m.envVars.map((e) => e.name),
    ...(sendSource ? { snippets: (s.snippets.get(m.id) ?? []).map((x) => ({ ...x })) } : {}),
  };
}

function summaryList(v: unknown, field: string, allowed: Set<string>): { key: string; summary: string }[] | string {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return `${field} must be an array`;
  const out: { key: string; summary: string }[] = [];
  for (const x of v as unknown[]) {
    const o = x as { key?: unknown; summary?: unknown } | null;
    if (typeof o?.key !== 'string' || typeof o.summary !== 'string') return `${field} items must have string key and summary`;
    if (allowed.has(o.key) && o.summary.trim()) out.push({ key: o.key, summary: o.summary.trim() });
  }
  return out;
}

function validateModule(input: ModuleSummaryInput): (value: unknown) => JsonParseResult<ModuleSummary> {
  const symbols = new Set(input.symbols.map((x) => x.key));
  const models = new Set(input.models.map((x) => x.key));
  return (value) => {
    const o = value as Record<string, unknown> | null;
    if (typeof o?.name !== 'string' || !o.name.trim()) return { ok: false, reason: '"name" must be a non-empty string' };
    if (typeof o.responsibility !== 'string') return { ok: false, reason: '"responsibility" must be a string' };
    const interfaces = summaryList(o.interfaces, 'interfaces', symbols);
    const modelList = summaryList(o.models, 'models', models);
    if (typeof interfaces === 'string') return { ok: false, reason: interfaces };
    if (typeof modelList === 'string') return { ok: false, reason: modelList };
    return { ok: true, value: { name: o.name.trim(), responsibility: o.responsibility.trim(), interfaces, models: modelList } };
  };
}

export function moduleRequest(s: OverviewStructure, m: OverviewModule, sendSource: boolean): AiRequest<ModuleSummary> {
  const input = moduleInput(s, m, sendSource);
  const truncated = fitModuleInput(input);
  return { kind: 'module', target: m.id, input: JSON.stringify(input), truncated, validate: validateModule(input), jsonSchema: OVERVIEW_JSON_SCHEMAS.module };
}

// ---------- 功能命名 ----------

/** 每个入口直接调用的符号 key（按 key 排序前 MAX_ENTRY_CALLS 个） */
export function entryCalls(g: OverviewGraph): Map<string, string[]> {
  const all = new Map<string, Set<string>>();
  for (const e of g.links) {
    if (e.kind !== 'call' || !g.entries.has(e.srcId) || e.srcId === e.dstId) continue;
    addToSet(all, e.srcId, g.symbols.get(e.dstId)!.symbolKey);
  }
  return new Map([...all].map(([id, keys]) => [id, [...keys].sort().slice(0, MAX_ENTRY_CALLS)]));
}

export function featureInput(g: OverviewGraph, calls: Map<string, string[]>, moduleId: string, features: Feature[]): FeatureNamingInput {
  const groups = features.map((f) => ({
    name: f.name,
    entries: f.entries.map((e) => {
      const doc = docFirstLine(g.symbols.get(e.symbol.id)?.docstring ?? null);
      return { key: e.symbol.key, kind: e.kind, ...(e.method ? { method: e.method } : {}), ...(e.path ? { path: e.path } : {}), ...(doc ? { doc } : {}), calls: calls.get(e.symbol.id) ?? [] };
    }),
  }));
  return { task: 'feature_naming', module: moduleId, groups };
}

/** 校验后的值和回复同形（缓存里存的就是它，读缓存时再校验一次） */
function validateFeatures(value: unknown): JsonParseResult<{ features: NamedFeature[] }> {
  const list = (value as { features?: unknown } | null)?.features;
  if (!Array.isArray(list)) return { ok: false, reason: 'missing "features" array' };
  const out: NamedFeature[] = [];
  for (const [i, x] of (list as unknown[]).entries()) {
    const o = x as Record<string, unknown> | null;
    if (typeof o?.name !== 'string' || !o.name.trim()) return { ok: false, reason: `features[${i}].name must be a non-empty string` };
    if (!isStringArray(o.entryKeys)) return { ok: false, reason: `features[${i}].entryKeys must be an array of strings` };
    const description = typeof o.description === 'string' && o.description.trim() ? o.description.trim() : undefined;
    out.push({ name: o.name.trim(), entryKeys: o.entryKeys, ...(description ? { description } : {}) });
  }
  return { ok: true, value: { features: out } };
}

export function featureRequest(g: OverviewGraph, calls: Map<string, string[]>, moduleId: string, features: Feature[]): AiRequest<{ features: NamedFeature[] }> {
  return { kind: 'features', target: moduleId, input: JSON.stringify(featureInput(g, calls, moduleId, features)), truncated: false, validate: validateFeatures, jsonSchema: OVERVIEW_JSON_SCHEMAS.features };
}

// ---------- 系统简介 ----------

export function validateSystem(value: unknown): JsonParseResult<SystemSummary> {
  const o = value as Record<string, unknown> | null;
  if (typeof o?.title !== 'string' || !o.title.trim()) return { ok: false, reason: '"title" must be a non-empty string' };
  if (typeof o.summary !== 'string' || !o.summary.trim()) return { ok: false, reason: '"summary" must be a non-empty string' };
  return { ok: true, value: { title: o.title.trim(), summary: o.summary.trim() } };
}

export function systemModuleLines(modules: OverviewModule[]): SystemModuleLine[] {
  return modules.map((m) => ({ id: m.id, name: m.name, ...(m.responsibility ? { responsibility: m.responsibility } : {}), size: m.size, httpApis: m.httpApis }));
}

/** 模块依赖边按 weight 从高到低取前 MAX_SYSTEM_EDGES 条；只取两端都在 ids 里的 */
export function systemEdges(s: OverviewStructure, ids?: Set<string>): SystemInput['edges'] {
  return s.moduleEdges
    .filter((e) => e.weight > 0 && (!ids || (ids.has(e.from) && ids.has(e.to))))
    .sort((a, b) => b.weight - a.weight || compareStrings(a.from, b.from) || compareStrings(a.to, b.to))
    .slice(0, MAX_SYSTEM_EDGES)
    .map((e) => ({ from: e.from, to: e.to, weight: e.weight }));
}

export function systemRequest(kind: 'system' | 'system_group', target: string, input: SystemInput): AiRequest<SystemSummary> {
  return { kind, target, input: JSON.stringify(input), truncated: false, validate: validateSystem, jsonSchema: OVERVIEW_JSON_SCHEMAS[kind] };
}

/** 回复先按 JSON 解析再交给 validate */
export function parseReply<T>(req: AiRequest<T>, reply: string): JsonParseResult<T> {
  const parsed = parseJsonReply(reply);
  return parsed.ok ? req.validate(parsed.value) : parsed;
}
