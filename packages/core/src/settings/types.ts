export type LlmProvider = 'anthropic' | 'openai-compatible';

/** 放在 settings 里，config 和 settings 共用且不形成循环引用（config 依赖 settings） */
export const isLlmProvider = (v: unknown): v is LlmProvider => v === 'anthropic' || v === 'openai-compatible';

/** 用户设置里的模型服务配置，每一项都可以没有；没有的项按环境变量、仓库配置、默认值取 */
export interface UserLlmSettings {
  provider?: LlmProvider;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
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
