import { readFile } from 'node:fs/promises';
import path from 'node:path';

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

export const CONFIG_FILE = 'codeinsight.config.json';
export const DEFAULT_DATA_DIR = '.codeinsight';

async function readFileConfig(repo: string): Promise<FileConfig> {
  try {
    return JSON.parse(await readFile(path.join(repo, CONFIG_FILE), 'utf8')) as FileConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`failed to read ${CONFIG_FILE}: ${(err as Error).message}`);
  }
}

function resolveLlm(file: FileConfig, env: NodeJS.ProcessEnv): LlmConfig | undefined {
  const provider = (env.CODEINSIGHT_LLM_PROVIDER ?? file.llm?.provider) as LlmProvider | undefined;
  if (!provider) return undefined;
  if (provider !== 'anthropic' && provider !== 'openai-compatible') {
    throw new Error(`unsupported LLM provider: ${provider}`);
  }
  const model = env.CODEINSIGHT_LLM_MODEL ?? file.llm?.model;
  if (!model) throw new Error('LLM provider configured but model is missing');
  const keyEnv = file.llm?.apiKeyEnv;
  const apiKey =
    env.CODEINSIGHT_LLM_API_KEY ??
    (keyEnv ? env[keyEnv] : undefined) ??
    file.llm?.apiKey ??
    (provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY);
  return { provider, model, baseUrl: env.CODEINSIGHT_LLM_BASE_URL ?? file.llm?.baseUrl, apiKey };
}

export interface LoadConfigOptions {
  /** 命令行的 --data-dir，优先级最高 */
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
}

/** 配置优先级：命令行 > 环境变量 > codeinsight.config.json > 默认值 */
export async function loadConfig(repo: string, opts: LoadConfigOptions = {}): Promise<CodeInsightConfig> {
  const env = opts.env ?? process.env;
  const file = await readFileConfig(repo);
  const dataDirRaw = opts.dataDir ?? env.CODEINSIGHT_DATA_DIR ?? file.dataDir ?? DEFAULT_DATA_DIR;
  return {
    repo,
    dataDir: path.resolve(repo, dataDirRaw),
    moduleDepth: file.moduleDepth ?? 3,
    testGlobs: file.testGlobs ?? [],
    generatedGlobs: file.generatedGlobs ?? [],
    scipTimeoutMs: Number(env.CODEINSIGHT_SCIP_TIMEOUT_MS ?? file.scipTimeoutMs ?? 300_000),
    impactDepth: file.impactDepth ?? 2,
    similarMinScore: file.similar?.minScore ?? 0.6,
    llm: resolveLlm(file, env),
  };
}

/** 数据目录在仓库内时返回相对路径（用于从文件清单中排除），否则返回 undefined */
export function dataDirInRepo(cfg: Pick<CodeInsightConfig, 'repo' | 'dataDir'>): string | undefined {
  const rel = path.relative(cfg.repo, cfg.dataDir);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join('/');
}
