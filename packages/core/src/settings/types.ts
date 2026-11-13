/** 通过 HTTP API 调用的模型服务 */
export type ApiLlmProvider = 'anthropic' | 'openai-compatible';
/** 本机安装的命令行工具，用它自己的登录状态调用模型 */
export type CliLlmProvider = 'claude-code' | 'opencode';
export type LlmProvider = ApiLlmProvider | CliLlmProvider;

/** 放在 settings 里，config 和 settings 共用且不形成循环引用（config 依赖 settings） */
export const isApiProvider = (v: unknown): v is ApiLlmProvider => v === 'anthropic' || v === 'openai-compatible';
export const isCliProvider = (v: unknown): v is CliLlmProvider => v === 'claude-code' || v === 'opencode';
export const isLlmProvider = (v: unknown): v is LlmProvider => isApiProvider(v) || isCliProvider(v);

/** 没有配置命令路径时在 PATH 里查找的命令名 */
export const DEFAULT_CLI_COMMAND: Record<CliLlmProvider, string> = { 'claude-code': 'claude', opencode: 'opencode' };

/** 用户设置里的模型服务配置，每一项都可以没有；没有的项按环境变量、仓库配置、默认值取 */
export interface UserLlmSettings {
  provider?: LlmProvider;
  /** 只用于 API provider */
  baseUrl?: string;
  model?: string;
  /** 只用于 API provider */
  apiKey?: string;
  /** 只用于 CLI provider：可执行文件的绝对路径或命令名 */
  command?: string;
  /** 只用于 CLI provider：启动命令时附加的环境变量 */
  extraEnv?: Record<string, string>;
}

export interface RecentRepo {
  /** 仓库根目录的真实路径 */
  path: string;
  /** 毫秒时间戳 */
  lastOpenedAt: number;
}

export interface UserSettings {
  llm?: UserLlmSettings;
  autoReindex?: boolean;
  /** 按 lastOpenedAt 从新到旧 */
  recentRepos: RecentRepo[];
}

export interface UserSettingsOptions {
  /** 设置文件路径，默认 userSettingsPath() */
  path?: string;
}
