import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { log } from '../log.js';
import { DEFAULT_LAYER_NAMES, LAYERS, type LayerNames } from '../overview/boundary.js';
import { EXTERNAL_CATEGORIES } from '../overview/external-table.js';
import { DEFAULT_PARTITION_THRESHOLDS, type PartitionThresholds } from '../overview/partition-state.js';
import { DEFAULT_SNIPPET_LIMITS, type SnippetLimits } from '../overview/snippets.js';
import type { ExternalCategory } from '../overview/types.js';
import type { Warning } from '../report/types.js';
import {
  commandProblem, isApiProvider, isCliProvider, isLlmProvider, modelProblem, readUserSettings, userSettingsPath,
  type ApiLlmProvider, type LlmProvider, type UserLlmSettings, type UserSettings,
} from '../settings/index.js';

export type { LlmProvider };

export interface LlmConfig {
  provider: LlmProvider;
  /** CLI provider 可以为空串：用 CLI 自己的默认模型 */
  model: string;
  baseUrl?: string;
  apiKey?: string;
  /** CLI provider 的可执行文件；undefined 表示按默认命令名查找 */
  command?: string;
  /** CLI provider 启动时附加的环境变量 */
  extraEnv?: Record<string, string>;
}

export interface CodeInsightConfig {
  repo: string;
  /** 绝对路径 */
  dataDir: string;
  moduleDepth: number;
  testGlobs: string[];
  generatedGlobs: string[];
  scipTimeoutMs: number;
  impactDepth: number;
  similarMinScore: number;
  /** 概览的划分、分层、外部库分类（仓库配置直接生效），以及费用和发送相关的上限（仓库配置只能调严） */
  overview: OverviewConfig;
  /** 问答的轮数和工具结果上限（仓库配置只能调低） */
  ask: AskConfig;
  llm?: LlmConfig;
  /** LLM 配置有误（provider 不支持、缺 model）时的原因；此时 llm 为 undefined，意图检查转成 llm_not_configured */
  llmProblem?: string;
  /** 读取配置时发现的问题，review 时写进报告的 warnings */
  warnings?: Warning[];
}

export interface OverviewConfig extends PartitionThresholds {
  /** 各层对应的文件名或目录名；仓库配置里给出的层整层替换默认值 */
  layers: LayerNames;
  /** 追加或覆盖内置分类表：点分模块名 → 类别 */
  externalCategories: Record<string, ExternalCategory>;
  /** 生成的名称和说明用的语言 */
  language: string;
  /** 是否把源码发给 LLM（同时管概览的源码片段和问答读源码）；仓库配置、环境变量任一处关闭即不发 */
  sendSource: boolean;
  /** 源码片段上限 */
  snippets: SnippetLimits;
  /** 同时进行的 LLM 请求数 */
  concurrency: number;
  /** 估算输入 token 超过它时要二次确认；0 表示总是确认 */
  confirmTokens: number;
}

export interface AskConfig {
  /** 一个问题最多几轮工具调用 */
  maxRounds: number;
  /** 一个问题里工具结果累计字符上限 */
  maxToolChars: number;
}

export const DEFAULT_OVERVIEW_LANGUAGE = 'zh';
export const DEFAULT_OVERVIEW_CONCURRENCY = 4;
/** 本机 CLI 每个请求是一个子进程，默认并发比 API 低 */
export const DEFAULT_CLI_CONCURRENCY = 2;
export const DEFAULT_CONFIRM_TOKENS = 200_000;
export const DEFAULT_ASK_CONFIG: AskConfig = { maxRounds: 12, maxToolChars: 120_000 };

/** 放宽费用和发送相关上限只能用这些环境变量 */
export const LIMIT_ENV = {
  sendSource: 'CODEINSIGHT_SEND_SOURCE',
  snippets: 'CODEINSIGHT_OVERVIEW_SNIPPETS',
  concurrency: 'CODEINSIGHT_OVERVIEW_CONCURRENCY',
  confirmTokens: 'CODEINSIGHT_OVERVIEW_CONFIRM_TOKENS',
  maxRounds: 'CODEINSIGHT_ASK_MAX_ROUNDS',
  maxToolChars: 'CODEINSIGHT_ASK_MAX_TOOL_CHARS',
} as const;

interface FileOverviewConfig extends Partial<PartitionThresholds> {
  layers?: Partial<Record<string, unknown>>;
  externalCategories?: Record<string, unknown>;
  language?: unknown;
  sendSource?: unknown;
  snippets?: Partial<Record<keyof SnippetLimits, unknown>>;
  concurrency?: unknown;
  confirmTokens?: unknown;
}

interface FileConfig {
  dataDir?: string;
  moduleDepth?: number;
  testGlobs?: string[];
  generatedGlobs?: string[];
  scipTimeoutMs?: number;
  impactDepth?: number;
  similar?: { minScore?: number };
  overview?: FileOverviewConfig;
  ask?: Partial<Record<keyof AskConfig, unknown>>;
  llm?: Partial<LlmConfig> & { apiKeyEnv?: string };
}

/** provider 为 anthropic 且没有配置 model 时使用 */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

export const CONFIG_FILE = 'codeinsight.config.json';
export const DEFAULT_DATA_DIR = '.codeinsight';

/**
 * 不读仓库配置、只能从环境变量或用户设置读取的 LLM 配置项。仓库里的配置文件随被审查的代码一起来，不可信：
 * 能改请求地址或指定读取哪个环境变量，就能把用户的 API key 或其他环境变量发到任意地址。
 */
const ENV_ONLY_LLM_KEYS: Record<string, string | null> = {
  baseUrl: 'CODEINSIGHT_LLM_BASE_URL',
  apiKey: 'CODEINSIGHT_LLM_API_KEY',
  apiKeyEnv: 'CODEINSIGHT_LLM_API_KEY',
  /** 能指定命令路径就能让 CodeInsight 执行仓库里的任意程序 */
  command: 'CODEINSIGHT_LLM_COMMAND',
  /** 能指定附加环境变量就能改代理地址把请求转走；只能写在用户设置里 */
  extraEnv: null,
};

/** 仓库配置里出现只能从环境变量或用户设置读取的项时忽略，记日志并返回给报告的 warning */
function ignoredLlmKeys(file: FileConfig): Warning[] {
  const llm = (file.llm ?? {}) as Record<string, unknown>;
  const keys = Object.keys(ENV_ONLY_LLM_KEYS).filter((k) => llm[k] !== undefined);
  if (keys.length === 0) return [];
  log.warn('config_llm_key_ignored', { keys: keys.join(',') });
  const envs = [...new Set(keys.map((k) => ENV_ONLY_LLM_KEYS[k]).filter((e) => e !== null))];
  const where = envs.length > 0 ? `environment variables (${envs.join(', ')}) or in the user settings` : 'the user settings';
  return [{
    code: 'config_llm_key_ignored', level: 'warning',
    message: `ignored ${keys.map((k) => `llm.${k}`).join(', ')} in ${CONFIG_FILE}: for safety these can only be set by ${where}`,
  }];
}

/**
 * 仓库配置不能选 CLI provider：那会在用户机器上启动本机程序、消耗用户的订阅额度。
 * llmSources 里按仓库配置没写 provider 处理。
 */
function ignoredRepoProvider(file: FileConfig): Warning[] {
  const provider = file.llm?.provider;
  if (!isCliProvider(provider)) return [];
  log.warn('config_llm_provider_ignored', { provider });
  return [{
    code: 'config_llm_provider_ignored', level: 'warning',
    message: `ignored llm.provider=${provider} in ${CONFIG_FILE}: a local CLI can only be chosen in the user settings or by CODEINSIGHT_LLM_PROVIDER`,
  }];
}

async function readFileConfig(repo: string): Promise<FileConfig> {
  try {
    return JSON.parse(await readFile(path.join(repo, CONFIG_FILE), 'utf8')) as FileConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`failed to read ${CONFIG_FILE}: ${(err as Error).message}`);
  }
}

const isIntAtLeast = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;

/** 划分阈值只接受正整数，其他值记日志后用默认值 */
function partitionThresholds(file: FileConfig): PartitionThresholds {
  const out = { ...DEFAULT_PARTITION_THRESHOLDS };
  for (const key of Object.keys(out) as (keyof PartitionThresholds)[]) {
    const v = file.overview?.[key];
    if (v === undefined) continue;
    if (isIntAtLeast(v, 1)) out[key] = v;
    else log.warn('config_value_ignored', { key: `overview.${key}`, reason: 'expected a positive integer' });
  }
  return out;
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '');
}

/** 给出的层整层替换默认名单；不认识的层名或格式不对的值记日志后忽略 */
function layerNames(file: FileConfig): LayerNames {
  const out: LayerNames = { ...DEFAULT_LAYER_NAMES };
  for (const [layer, names] of Object.entries(file.overview?.layers ?? {})) {
    if ((LAYERS as readonly string[]).includes(layer) && isStringList(names)) out[layer as keyof LayerNames] = names;
    else log.warn('config_value_ignored', { key: `overview.layers.${layer}`, reason: 'expected one of entry/service/data/common with a list of names' });
  }
  return out;
}

/** 只接受点分模块名 → 内置类别，其他记日志后忽略 */
function externalCategories(file: FileConfig): Record<string, ExternalCategory> {
  const out: Record<string, ExternalCategory> = {};
  for (const [mod, category] of Object.entries(file.overview?.externalCategories ?? {})) {
    if (/^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)*$/.test(mod) && (EXTERNAL_CATEGORIES as readonly unknown[]).includes(category)) out[mod] = category as ExternalCategory;
    else log.warn('config_value_ignored', { key: `overview.externalCategories.${mod}`, reason: 'expected a dotted module name mapped to a known category' });
  }
  return out;
}

/** 语言写进提示词，只接受 `zh`、`en-US` 这样的语言标记 */
function overviewLanguage(file: FileConfig): string {
  const v = file.overview?.language;
  if (v === undefined) return DEFAULT_OVERVIEW_LANGUAGE;
  if (typeof v === 'string' && /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/.test(v)) return v;
  log.warn('config_value_ignored', { key: 'overview.language', reason: 'expected a language tag such as zh or en' });
  return DEFAULT_OVERVIEW_LANGUAGE;
}

function overviewConfig(file: FileConfig, limits: CostLimits): OverviewConfig {
  return {
    ...partitionThresholds(file), layers: layerNames(file), externalCategories: externalCategories(file), language: overviewLanguage(file),
    sendSource: limits.sendSource, snippets: limits.snippets, concurrency: limits.concurrency, confirmTokens: limits.confirmTokens,
  };
}

/** 环境变量里的整数列表（逗号分隔，个数为 count，都不小于 min）；没设时 undefined，格式不对时记日志后按没设处理 */
function envInts(env: NodeJS.ProcessEnv, name: string, count: number, min: number): number[] | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parts = raw.split(',').map((x) => Number(x.trim()));
  if (parts.length === count && parts.every((v) => isIntAtLeast(v, min))) return parts;
  log.warn('config_env_ignored', { name, value: raw, reason: `expected ${count} comma-separated integer(s) >= ${min}` });
  return undefined;
}

/** 环境变量能关闭源码发送，不能打开仓库配置关掉的 */
export function envTurnsOff(env: NodeJS.ProcessEnv, name: string): boolean {
  return /^(0|false|no|off)$/i.test(env[name]?.trim() ?? '');
}

interface IgnoredLimit {
  key: string;
  env: string;
}

interface LimitSpec {
  /** 仓库配置里的键，用于日志和 warning */
  key: string;
  env: string;
  def: number;
  /** 环境变量给出的值，设了时代替默认值作为上限 */
  envValue?: number;
  repo: unknown;
  /** 允许的最小值（confirmTokens 为 0 表示总是确认） */
  min: number;
}

/**
 * 仓库配置只能比上限（环境变量的值，没设时为默认值）更严格：比上限宽时用上限。仓库配置随被分析的代码一起来，不能让它放大费用。
 * 只有没设环境变量、仓库配置想超过默认值时才记下，由调用方汇总成 `config_limit_ignored` 提示改用环境变量；
 * 用户已经用环境变量定了上限时只记日志。
 */
export function stricterLimit(spec: LimitSpec, ignored: IgnoredLimit[]): number {
  const ceiling = spec.envValue ?? spec.def;
  if (spec.repo === undefined) return ceiling;
  if (!isIntAtLeast(spec.repo, spec.min)) {
    log.warn('config_value_ignored', { key: spec.key, reason: `expected an integer >= ${spec.min}` });
    return ceiling;
  }
  if (spec.repo <= ceiling) return spec.repo;
  if (spec.envValue === undefined) ignored.push({ key: spec.key, env: spec.env });
  else log.info('config_limit_capped', { key: spec.key, env: spec.env, repo: spec.repo, effective: ceiling });
  return ceiling;
}

interface CostLimits {
  sendSource: boolean;
  snippets: SnippetLimits;
  concurrency: number;
  confirmTokens: number;
  ask: AskConfig;
  ignored: IgnoredLimit[];
  warnings: Warning[];
}

function snippetLimits(file: FileConfig, env: NodeJS.ProcessEnv, ignored: IgnoredLimit[]): SnippetLimits {
  const fromEnv = envInts(env, LIMIT_ENV.snippets, 3, 1);
  const keys: (keyof SnippetLimits)[] = ['perModule', 'maxLines', 'maxCharsPerModule'];
  const out = { ...DEFAULT_SNIPPET_LIMITS };
  keys.forEach((k, i) => {
    out[k] = stricterLimit({ key: `overview.snippets.${k}`, env: LIMIT_ENV.snippets, def: DEFAULT_SNIPPET_LIMITS[k], envValue: fromEnv?.[i], repo: file.overview?.snippets?.[k], min: 1 }, ignored);
  });
  return out;
}

/** 单个数值上限：环境变量（没设时默认值）定上限，仓库配置只能调低 */
function singleLimit(env: NodeJS.ProcessEnv, spec: Omit<LimitSpec, 'envValue'>, ignored: IgnoredLimit[]): number {
  return stricterLimit({ ...spec, envValue: envInts(env, spec.env, 1, spec.min)?.[0] }, ignored);
}

/** 仓库配置的 sendSource：不是布尔值时按关闭处理（写错了宁可不发源码），并给出 warning */
function repoSendSource(file: FileConfig, warnings: Warning[]): boolean {
  const v = file.overview?.sendSource;
  if (v === undefined || typeof v === 'boolean') return v !== false;
  log.warn('config_value_ignored', { key: 'overview.sendSource', reason: 'expected a boolean; source sending turned off' });
  warnings.push({
    code: 'config_value_invalid', level: 'warning',
    message: `overview.sendSource in ${CONFIG_FILE} is not true or false; source code will not be sent to the LLM`,
  });
  return false;
}

/**
 * 费用和发送相关的配置：仓库配置只能调严，放宽只能用环境变量（或命令行参数）。
 * provider 是生效的 provider，决定并发的默认值。
 */
function costLimits(file: FileConfig, env: NodeJS.ProcessEnv, provider: LlmProvider | undefined): CostLimits {
  const ignored: IgnoredLimit[] = [];
  const warnings: Warning[] = [];
  const L = LIMIT_ENV;
  const ov = file.overview;
  return {
    sendSource: repoSendSource(file, warnings) && !envTurnsOff(env, L.sendSource),
    snippets: snippetLimits(file, env, ignored),
    concurrency: singleLimit(env, { key: 'overview.concurrency', env: L.concurrency, def: isCliProvider(provider) ? DEFAULT_CLI_CONCURRENCY : DEFAULT_OVERVIEW_CONCURRENCY, repo: ov?.concurrency, min: 1 }, ignored),
    confirmTokens: singleLimit(env, { key: 'overview.confirmTokens', env: L.confirmTokens, def: DEFAULT_CONFIRM_TOKENS, repo: ov?.confirmTokens, min: 0 }, ignored),
    ask: {
      maxRounds: singleLimit(env, { key: 'ask.maxRounds', env: L.maxRounds, def: DEFAULT_ASK_CONFIG.maxRounds, repo: file.ask?.maxRounds, min: 1 }, ignored),
      maxToolChars: singleLimit(env, { key: 'ask.maxToolChars', env: L.maxToolChars, def: DEFAULT_ASK_CONFIG.maxToolChars, repo: file.ask?.maxToolChars, min: 1 }, ignored),
    },
    ignored,
    warnings,
  };
}

/** 被忽略的上限汇总成一条 warning，写明应改用的环境变量 */
function ignoredLimitWarnings(ignored: IgnoredLimit[]): Warning[] {
  if (ignored.length === 0) return [];
  log.warn('config_limit_ignored', { keys: ignored.map((i) => i.key).join(',') });
  const envs = [...new Set(ignored.map((i) => i.env))].join(', ');
  return [{
    code: 'config_limit_ignored', level: 'warning',
    message: `ignored ${ignored.map((i) => i.key).join(', ')} in ${CONFIG_FILE}: the repository config can only lower these limits; to raise them set ${envs}`,
  }];
}

export type LlmSource = 'user' | 'env' | 'repo' | 'default' | 'none';
export type LlmField = 'provider' | 'model' | 'baseUrl' | 'apiKey' | 'command';

export interface LlmFieldSource {
  /** 取到的值；baseUrl 用客户端内置默认值、command 用默认命令名时为 undefined */
  value?: string;
  source: LlmSource;
  /** source 为 env 时的变量名 */
  env?: string;
}

export interface LlmExtraEnvSource {
  /** 只来自用户设置 */
  value?: Record<string, string>;
  source: 'user' | 'none';
}

export interface LlmSources {
  provider: LlmFieldSource;
  model: LlmFieldSource;
  /** CLI provider 时来源为 none */
  baseUrl: LlmFieldSource;
  /** CLI provider 时来源为 none */
  apiKey: LlmFieldSource;
  /** 只用于 CLI provider；API provider 时来源为 none */
  command: LlmFieldSource;
  extraEnv: LlmExtraEnvSource;
  /** 环境变量也设了值、但被用户设置盖住的项 */
  shadowed: { field: LlmField; by: 'user'; env: string }[];
  /** 生效的配置；provider 没有或有误时为 undefined */
  llm?: LlmConfig;
  /** 配置有误（provider 不支持、缺 model）时的原因 */
  problem?: string;
}

export interface LlmSourcesInput {
  user?: UserLlmSettings;
  /** 仓库配置里的 llm 部分；没有仓库时不传。只取 API provider 和 model */
  repo?: { provider?: unknown; model?: unknown };
  env: NodeJS.ProcessEnv;
}

/** 各 LLM 配置项对应的环境变量 */
export const LLM_ENV = {
  provider: 'CODEINSIGHT_LLM_PROVIDER',
  model: 'CODEINSIGHT_LLM_MODEL',
  baseUrl: 'CODEINSIGHT_LLM_BASE_URL',
  apiKey: 'CODEINSIGHT_LLM_API_KEY',
  command: 'CODEINSIGHT_LLM_COMMAND',
} as const;

const PROVIDER_KEY_ENV: Record<ApiLlmProvider, string> = { anthropic: 'ANTHROPIC_API_KEY', 'openai-compatible': 'OPENAI_API_KEY' };

/** 用户设置 > 环境变量（按顺序取第一个有值的）> 仓库配置；空字符串按没设处理 */
function pickField(user: string | undefined, env: NodeJS.ProcessEnv, envNames: string[], repo?: unknown): LlmFieldSource {
  if (user) return { value: user, source: 'user' };
  for (const name of envNames) if (env[name]) return { value: env[name], source: 'env', env: name };
  if (repo !== undefined && repo !== null && repo !== '') return { value: String(repo), source: 'repo' };
  return { source: 'none' };
}

/** 用户设置盖住了环境变量的项（环境变量取 envNames 里第一个有值的） */
function shadowedBy(field: LlmField, user: string | undefined, env: NodeJS.ProcessEnv, envNames: string[]): LlmSources['shadowed'] {
  const name = envNames.find((n) => env[n]);
  return user && name ? [{ field, by: 'user', env: name }] : [];
}

/** 不合格的值记日志后按没设处理；日志不记值 */
function checked(v: unknown, key: string, problemOf: (v: unknown) => string | undefined): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const problem = problemOf(v);
  if (problem === undefined) return v as string;
  log.warn('config_value_ignored', { key, reason: problem });
  return undefined;
}

/** 环境变量里不合格的值去掉，后续按没设处理 */
function checkedEnv(env: NodeJS.ProcessEnv, name: string, problemOf: (v: unknown) => string | undefined): NodeJS.ProcessEnv {
  const v = checked(env[name], name, problemOf);
  return v === undefined ? {} : { [name]: v };
}

/** 仓库配置里的 CLI provider 不算来源（ignoredRepoProvider 给 warning） */
function pickProvider(user: UserLlmSettings, repo: LlmSourcesInput['repo'], env: NodeJS.ProcessEnv): LlmFieldSource {
  const repoProvider = isCliProvider(repo?.provider) ? undefined : repo?.provider;
  return pickField(user.provider, env, [LLM_ENV.provider], repoProvider);
}

/**
 * CLI provider 的 model 不读仓库配置；环境变量只在 provider 也来自环境变量时用，
 * 避免给 API 用的模型名被传给 CLI，也不让仓库换用更贵的模型。
 */
function pickModel(input: LlmSourcesInput, provider: LlmFieldSource): { model: LlmFieldSource; invalidIgnored: boolean } {
  const { user = {}, repo = {}, env } = input;
  const cli = isCliProvider(provider.value);
  const envUsable = !cli || provider.source === 'env';
  const userModel = checked(user.model, 'llm.model', modelProblem);
  const envModel = envUsable ? checkedEnv(env, LLM_ENV.model, modelProblem) : {};
  const repoModel = cli ? undefined : checked(repo.model, `llm.model in ${CONFIG_FILE}`, modelProblem);
  const model = pickField(userModel, envModel, [LLM_ENV.model], repoModel);
  if (model.source === 'none' && provider.value === 'anthropic') Object.assign(model, { value: DEFAULT_ANTHROPIC_MODEL, source: 'default' });
  const given = (v: unknown) => v !== undefined && v !== null && v !== '';
  const invalidIgnored = (given(user.model) && !userModel) || (envUsable && given(env[LLM_ENV.model]) && !envModel[LLM_ENV.model])
    || (!cli && given(repo.model) && !repoModel);
  return { model, invalidIgnored };
}

/** 只用于 CLI provider：用户设置 > CODEINSIGHT_LLM_COMMAND > 默认命令名（value 为 undefined） */
function pickCommand(user: UserLlmSettings, env: NodeJS.ProcessEnv, cli: boolean): LlmFieldSource {
  if (!cli) return { source: 'none' };
  const command = pickField(checked(user.command, 'llm.command', (v) => commandProblem(v)), checkedEnv(env, LLM_ENV.command, (v) => commandProblem(v)), [LLM_ENV.command]);
  return command.source === 'none' ? { source: 'default' } : command;
}

interface ApiFields {
  baseUrl: LlmFieldSource;
  apiKey: LlmFieldSource;
  shadowed: LlmSources['shadowed'];
}

/** 请求地址和 API key 只用于 API provider，CLI provider 时来源为 none */
function apiFields(user: UserLlmSettings, env: NodeJS.ProcessEnv, provider: LlmProvider | undefined): ApiFields {
  if (isCliProvider(provider)) return { baseUrl: { source: 'none' }, apiKey: { source: 'none' }, shadowed: [] };
  const keyEnvs = [LLM_ENV.apiKey, ...(provider ? [PROVIDER_KEY_ENV[provider]] : [])];
  const baseUrl = pickField(user.baseUrl, env, [LLM_ENV.baseUrl]);
  if (baseUrl.source === 'none' && provider) baseUrl.source = 'default';
  return {
    baseUrl,
    apiKey: pickField(user.apiKey, env, keyEnvs),
    shadowed: [...shadowedBy('baseUrl', user.baseUrl, env, [LLM_ENV.baseUrl]), ...shadowedBy('apiKey', user.apiKey, env, keyEnvs)],
  };
}

/** 生效的配置；provider 不支持、API provider 缺 model 时返回 problem */
function effectiveLlm(s: Omit<LlmSources, 'llm' | 'problem'>, modelInvalidIgnored: boolean): Pick<LlmSources, 'llm' | 'problem'> {
  const p = s.provider.value;
  if (p === undefined) return {};
  if (isCliProvider(p)) return { llm: { provider: p, model: s.model.value ?? '', command: s.command.value, extraEnv: s.extraEnv.value } };
  if (!isApiProvider(p)) return { problem: `unsupported LLM provider: ${p} (expected anthropic, openai-compatible, claude-code or opencode)` };
  if (!s.model.value) {
    const note = modelInvalidIgnored ? '; a model value with an invalid format was ignored' : '';
    return { problem: `LLM provider openai-compatible configured but model is missing (set CODEINSIGHT_LLM_MODEL or llm.model, or fill it in on the web settings page)${note}` };
  }
  return { llm: { provider: p, model: s.model.value, baseUrl: s.baseUrl.value, apiKey: s.apiKey.value } };
}

/**
 * LLM 各项的取值和来源。用户设置和环境变量都是用户自己给的，可以写请求地址、API key、命令路径；
 * 仓库配置随被分析的代码一起来，只取 API provider 和 model。配置有误时不抛错，返回 problem。
 */
export function llmSources(input: LlmSourcesInput): LlmSources {
  const { user = {}, env } = input;
  const provider = pickProvider(user, input.repo, env);
  const p = isLlmProvider(provider.value) ? provider.value : undefined;
  const cli = isCliProvider(p);
  const { model, invalidIgnored } = pickModel(input, provider);
  const command = pickCommand(user, env, cli);
  const api = apiFields(user, env, p);
  const extraEnv: LlmExtraEnvSource = user.extraEnv ? { value: user.extraEnv, source: 'user' } : { source: 'none' };
  const modelShadowed = !cli || provider.source === 'env' ? shadowedBy('model', user.model, env, [LLM_ENV.model]) : [];
  const shadowed = [
    ...shadowedBy('provider', user.provider, env, [LLM_ENV.provider]),
    ...modelShadowed,
    ...api.shadowed,
    ...(cli ? shadowedBy('command', user.command, env, [LLM_ENV.command]) : []),
  ];
  const out = { provider, model, baseUrl: api.baseUrl, apiKey: api.apiKey, command, extraEnv, shadowed };
  return { ...out, ...effectiveLlm(out, invalidIgnored) };
}

export interface LoadConfigOptions {
  /** 命令行的 --data-dir，优先级最高 */
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  /** 用户设置；不传时读用户设置文件，null 表示不读 */
  userSettings?: UserSettings | null;
}

/** 读用户设置出错（权限不足等）时记日志按空设置继续，不让所有命令都起不来 */
async function userSettingsFor(opts: LoadConfigOptions): Promise<UserSettings | undefined> {
  if (opts.userSettings !== undefined) return opts.userSettings ?? undefined;
  try {
    return await readUserSettings();
  } catch (err) {
    log.warn('user_settings_read_failed', { path: userSettingsPath(), error: (err as Error).message });
    return undefined;
  }
}

/**
 * LLM 各项的取值和来源（设置接口用）：没有仓库时不读仓库配置。
 * opts 同 loadConfig 的 env、userSettings。
 */
export async function loadLlmSources(repo: string | undefined, opts: Pick<LoadConfigOptions, 'env' | 'userSettings'> = {}): Promise<LlmSources> {
  const file = repo === undefined ? {} : await readFileConfig(repo);
  const user = await userSettingsFor(opts);
  return llmSources({ user: user?.llm, repo: file.llm, env: opts.env ?? process.env });
}

/**
 * 配置优先级：命令行 > 环境变量 > codeinsight.config.json > 默认值；
 * LLM 各项是用户设置 > 环境变量 > 仓库配置，请求地址和 API key 不读仓库配置。
 */
export async function loadConfig(repo: string, opts: LoadConfigOptions = {}): Promise<CodeInsightConfig> {
  const env = opts.env ?? process.env;
  const file = await readFileConfig(repo);
  const dataDirRaw = opts.dataDir ?? env.CODEINSIGHT_DATA_DIR ?? file.dataDir ?? DEFAULT_DATA_DIR;
  const user = await userSettingsFor(opts);
  const llm = llmSources({ user: user?.llm, repo: file.llm, env });
  if (llm.problem) log.warn('config_llm_invalid', { reason: llm.problem });
  const limits = costLimits(file, env, llm.llm?.provider);
  const warnings = [...ignoredLlmKeys(file), ...ignoredRepoProvider(file), ...ignoredLimitWarnings(limits.ignored), ...limits.warnings];
  return {
    repo,
    dataDir: path.resolve(repo, dataDirRaw),
    moduleDepth: file.moduleDepth ?? 3,
    testGlobs: file.testGlobs ?? [],
    generatedGlobs: file.generatedGlobs ?? [],
    scipTimeoutMs: Number(env.CODEINSIGHT_SCIP_TIMEOUT_MS ?? file.scipTimeoutMs ?? 300_000),
    impactDepth: file.impactDepth ?? 2,
    similarMinScore: file.similar?.minScore ?? 0.6,
    overview: overviewConfig(file, limits),
    ask: limits.ask,
    ...(llm.llm ? { llm: llm.llm } : {}),
    ...(llm.problem ? { llmProblem: llm.problem } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** 本次是否发送源码（概览和问答共用）：配置（仓库配置、环境变量）和命令行的 --no-source 任一处关闭即不发 */
export function effectiveSendSource(config: Pick<CodeInsightConfig, 'overview'>, noSource: boolean | undefined): boolean {
  return config.overview.sendSource && !noSource;
}

/** 数据目录在仓库内时返回相对路径（用于从文件清单中排除），否则返回 undefined */
export function dataDirInRepo(cfg: Pick<CodeInsightConfig, 'repo' | 'dataDir'>): string | undefined {
  const rel = path.relative(cfg.repo, cfg.dataDir);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join('/');
}
