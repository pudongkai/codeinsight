import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { log } from '../log.js';
import type { Warning } from '../report/types.js';

export type LlmProvider = 'anthropic' | 'openai-compatible';

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  baseUrl?: string;
  apiKey?: string;
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
  llm?: LlmConfig;
  /** LLM 配置有误（provider 不支持、缺 model）时的原因；此时 llm 为 undefined，意图检查转成 llm_not_configured */
  llmProblem?: string;
  /** 读取配置时发现的问题，review 时写进报告的 warnings */
  warnings?: Warning[];
}

interface FileConfig {
  dataDir?: string;
  moduleDepth?: number;
  testGlobs?: string[];
  generatedGlobs?: string[];
  scipTimeoutMs?: number;
  impactDepth?: number;
  similar?: { minScore?: number };
  llm?: Partial<LlmConfig> & { apiKeyEnv?: string };
}

/** provider 为 anthropic 且没有配置 model 时使用 */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

export const CONFIG_FILE = 'codeinsight.config.json';
export const DEFAULT_DATA_DIR = '.codeinsight';

/**
 * 只能从环境变量读取的 LLM 配置项。仓库里的配置文件随被审查的代码一起来，不可信：
 * 能改请求地址或指定读取哪个环境变量，就能把用户的 API key 或其他环境变量发到任意地址。
 */
const ENV_ONLY_LLM_KEYS: Record<string, string> = {
  baseUrl: 'CODEINSIGHT_LLM_BASE_URL',
  apiKey: 'CODEINSIGHT_LLM_API_KEY',
  apiKeyEnv: 'CODEINSIGHT_LLM_API_KEY',
};

/** 仓库配置里出现只能从环境变量读取的项时忽略，记日志并返回给报告的 warning */
function ignoredLlmKeys(file: FileConfig): Warning[] {
  const llm = (file.llm ?? {}) as Record<string, unknown>;
  const keys = Object.keys(ENV_ONLY_LLM_KEYS).filter((k) => llm[k] !== undefined);
  if (keys.length === 0) return [];
  log.warn('config_llm_key_ignored', { keys: keys.join(',') });
  const envs = [...new Set(keys.map((k) => ENV_ONLY_LLM_KEYS[k]))].join(', ');
  return [{
    code: 'config_llm_key_ignored', level: 'warning',
    message: `ignored ${keys.map((k) => `llm.${k}`).join(', ')} in ${CONFIG_FILE}: for safety these can only be set by environment variables (${envs})`,
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

type LlmResolution = { llm?: LlmConfig; problem?: string };

/**
 * provider 和 model 可来自环境变量或仓库配置；请求地址和 API key 只来自环境变量。
 * 配置有误时不抛错（否则所有命令都起不来），返回原因，由意图检查转成 warning。
 */
function resolveLlm(file: FileConfig, env: NodeJS.ProcessEnv): LlmResolution {
  const provider = env.CODEINSIGHT_LLM_PROVIDER ?? file.llm?.provider;
  if (!provider) return {};
  if (provider !== 'anthropic' && provider !== 'openai-compatible') {
    return { problem: `unsupported LLM provider: ${String(provider)} (expected anthropic or openai-compatible)` };
  }
  const model = env.CODEINSIGHT_LLM_MODEL ?? file.llm?.model ?? (provider === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : undefined);
  if (!model) return { problem: 'LLM provider openai-compatible configured but model is missing (set CODEINSIGHT_LLM_MODEL or llm.model)' };
  const apiKey = env.CODEINSIGHT_LLM_API_KEY ?? (provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY);
  return { llm: { provider, model, baseUrl: env.CODEINSIGHT_LLM_BASE_URL, apiKey } };
}

export interface LoadConfigOptions {
  /** 命令行的 --data-dir，优先级最高 */
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
}

/** 配置优先级：命令行 > 环境变量 > codeinsight.config.json > 默认值；LLM 的请求地址和 API key 只读环境变量 */
export async function loadConfig(repo: string, opts: LoadConfigOptions = {}): Promise<CodeInsightConfig> {
  const env = opts.env ?? process.env;
  const file = await readFileConfig(repo);
  const dataDirRaw = opts.dataDir ?? env.CODEINSIGHT_DATA_DIR ?? file.dataDir ?? DEFAULT_DATA_DIR;
  const llm = resolveLlm(file, env);
  if (llm.problem) log.warn('config_llm_invalid', { reason: llm.problem });
  const warnings = ignoredLlmKeys(file);
  return {
    repo,
    dataDir: path.resolve(repo, dataDirRaw),
    moduleDepth: file.moduleDepth ?? 3,
    testGlobs: file.testGlobs ?? [],
    generatedGlobs: file.generatedGlobs ?? [],
    scipTimeoutMs: Number(env.CODEINSIGHT_SCIP_TIMEOUT_MS ?? file.scipTimeoutMs ?? 300_000),
    impactDepth: file.impactDepth ?? 2,
    similarMinScore: file.similar?.minScore ?? 0.6,
    ...(llm.llm ? { llm: llm.llm } : {}),
    ...(llm.problem ? { llmProblem: llm.problem } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** 数据目录在仓库内时返回相对路径（用于从文件清单中排除），否则返回 undefined */
export function dataDirInRepo(cfg: Pick<CodeInsightConfig, 'repo' | 'dataDir'>): string | undefined {
  const rel = path.relative(cfg.repo, cfg.dataDir);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join('/');
}
