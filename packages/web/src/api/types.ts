/** HTTP API 的响应形状（与 packages/server/src/http/routes 一致） */
import type { ChatMessageInfo, ChatSessionInfo } from '@codeinsight/core/ask/events';
import type { OverviewReport } from '@codeinsight/core/overview/types';
import type { ReviewReport } from '@codeinsight/core/report/types';

export interface SymbolInfo {
  id: string;
  key: string;
  kind: string;
  name: string;
  qualifiedName: string;
  displaySignature: string;
  path: string;
  startLine: number;
  endLine: number;
  isTest: boolean;
  /** 数据模型类的类别（pydantic、sqlalchemy 等），不是模型时不存在 */
  modelKind?: string;
  /** 入口信息（有多个时优先 HTTP 入口），不是入口时不存在 */
  entry?: { kind: string; framework: string; detail: Record<string, unknown> };
}

export interface IndexJobView {
  id: number;
  reason: string;
  status: 'running' | 'done' | 'failed';
  snapshotId?: number;
  cached?: boolean;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface SnapshotView {
  id: number;
  kind: 'commit' | 'working';
  commitSha: string;
  /** 快照内容的 key：问答消息、概览记录的 contentKey 与它不同时提示“基于较早的代码” */
  contentKey: string;
  createdAt: number;
  resolverStatus: string;
  resolverError: string | null;
  /** 工作区快照包含未提交改动 */
  dirty: boolean;
}

export type ReviewStatus = 'running' | 'done' | 'failed';

export interface ReviewParams {
  base?: string;
  head?: string;
  working?: boolean;
  intent?: string;
  noLlm?: boolean;
}

export interface ReviewSummary {
  id: number;
  params: ReviewParams;
  status: ReviewStatus;
  error: string | null;
  progress: string | null;
  createdAt: number;
}

/** 代码变化检测的结果 */
export interface ChangesView {
  checkedAt: number | null;
  codeChanged: boolean;
  autoReindex: boolean;
  /** 当前变化的代码自动更新索引失败过，不再自动重试 */
  autoReindexFailed: boolean;
}

export interface StatusResponse {
  /** 当前仓库根目录；没有打开仓库时为 null */
  repo: string | null;
  /** 每打开一次仓库加 1；没有仓库时为 null */
  repoGen: number | null;
  /** serve 锁定了仓库（插件启动）：不显示切换入口 */
  repoLocked: boolean;
  /** 能弹出系统选择文件夹窗口 */
  dirPickerAvailable: boolean;
  changes: ChangesView;
  node: string;
  llmConfigured: boolean;
  /** 当前的 LLM 配置，未配置时为 null；model 为空串时用本机 CLI 的默认模型 */
  llm: { provider: string; model: string; kind?: 'api' | 'cli'; source?: 'user' | 'env' | 'repo' } | null;
  /** 未配置时的原因（配置有误、provider 暂不可用） */
  llmProblem?: string | null;
  /** 是否发送源码片段（仓库配置或环境变量关闭时为 false） */
  sendSource: boolean;
  index: { job: IndexJobView | null; lastDoneAt: number | null };
  snapshot: SnapshotView | null;
  reviews: ReviewSummary[];
  /** 当前概览的摘要，没有概览时为 null */
  overview: { id: number; createdAt: number; stale: boolean } | null;
}

export interface ReviewResponse {
  id: number;
  status: ReviewStatus;
  progress: string | null;
  params: ReviewParams;
  createdAt: number;
  error?: string;
  report?: ReviewReport;
}

export interface EntryItem {
  kind: string;
  framework: string;
  detail: Record<string, unknown>;
  symbol: SymbolInfo;
}

export interface TreeEdge {
  srcId: string;
  dstId: string;
  kind: string;
  path: string;
  line: number;
  /** 从 0 开始 */
  col: number;
}

export interface TreeResponse {
  snapshotId: number;
  resolverStatus: string;
  direction: 'callers' | 'callees';
  depth: number;
  root: SymbolInfo;
  nodes: (SymbolInfo & { depth: number })[];
  edges: TreeEdge[];
}

export interface NeighborCounts {
  total: number;
  prod: number;
  test: number;
}

export interface SymbolDetail {
  snapshotId: number;
  resolverStatus: string;
  symbol: SymbolInfo & { docstring: string | null; parent: SymbolInfo | null };
  entries: { kind: string; framework: string; detail: Record<string, unknown> }[];
  callers: NeighborCounts;
  callees: NeighborCounts;
}

export interface SourceResponse {
  snapshotId: number;
  path: string;
  start: number;
  end: number;
  totalLines: number;
  content: string;
}

/** GET /api/overview */
export interface OverviewResponse {
  id: number;
  overview: OverviewReport;
  /** 概览的 content_key 与当前快照不同 */
  stale: boolean;
  /** 当前快照未就绪时为 null */
  currentContentKey: string | null;
  /** 概览所基于的代码含未提交改动 */
  snapshotDirty: boolean;
  /** 比当前概览更新、但不含 AI 说明的记录 */
  newerStructureId?: number;
}

export interface OverviewParams {
  noLlm?: boolean;
  noSource?: boolean;
}

/** GET /api/overview/estimate（与 core 的 OverviewEstimate 一致） */
export interface OverviewEstimate {
  modules: number;
  llmCalls: number;
  cachedCalls: number;
  inputTokens: number;
  outputTokens: number;
  provider: string | null;
  model: string | null;
  sendSource: boolean;
  needsConfirm: boolean;
}

export type OverviewStep = 'partition' | 'modules' | 'features' | 'system';

/** GET /api/overview/jobs/:id */
export interface OverviewJob {
  id: number;
  status: 'running' | 'done' | 'failed';
  progress: { step: OverviewStep; done?: number; total?: number } | null;
  createdAt: number;
  finishedAt: number | null;
  error?: string;
}

/** GET /api/chat/sessions/:id */
export interface ChatSessionDetail extends ChatSessionInfo {
  /** 这个会话是否有问题正在回答（可能来自另一个页面） */
  answering: boolean;
  messages: ChatMessageInfo[];
}

/** GET /api/repos 的最近列表项 */
export interface RecentRepo {
  path: string;
  lastOpenedAt: number;
  /** 路径现在是否还是目录 */
  exists: boolean;
}

/** GET /api/repos */
export interface ReposResponse {
  current: { path: string; gen: number; dataDir: string } | null;
  startupRepo: string | null;
  locked: boolean;
  recent: RecentRepo[];
}

/** POST /api/repo 成功的响应 */
export interface OpenRepoResult {
  repo: string;
  repoGen: number;
  dataDir: string;
  /** 与当前仓库相同，什么都没做 */
  reused: boolean;
}

/** 409 repo_busy 里列出的任务 */
export interface RepoTask {
  kind: 'index' | 'overview' | 'review' | 'ask';
  id: number;
  cancellable: boolean;
}

/** POST /api/repo/pick-dir */
export type PickDirResult = { status: 'selected'; path: string } | { status: 'cancelled' } | { status: 'timeout' };

export type LlmProvider = 'anthropic' | 'openai-compatible' | 'claude-code' | 'opencode';
export type LlmSourceKind = 'user' | 'env' | 'repo' | 'default' | 'none';

export interface LlmFieldView {
  value: string | null;
  source: LlmSourceKind;
  /** source 为 env 时的变量名 */
  env?: string;
}

/** GET /api/settings */
export interface SettingsResponse {
  path: string;
  llm: {
    provider: LlmFieldView;
    baseUrl: LlmFieldView;
    model: LlmFieldView;
    /** 不含 key 原文；足够长时给末 4 位 */
    apiKey: { set: boolean; last4?: string; source: LlmSourceKind; env?: string };
    /** 本机 CLI 的命令路径；resolved 是实际找到的可执行文件（只在 provider 是 CLI 时查找） */
    command?: LlmFieldView & { resolved: string | null };
    /** 环境变量 CODEINSIGHT_LLM_COMMAND 指定的命令路径，没有为 null；当前生效的是 API provider 时也返回 */
    commandEnv?: string | null;
    /** 附加环境变量；多数变量不返回值，只给 set */
    extraEnv?: { source: 'user' | 'none'; entries: ExtraEnvView[] };
    /** 环境变量也设了值、但被用户设置盖住的项 */
    shadowed: { field: 'provider' | 'model' | 'baseUrl' | 'apiKey' | 'command'; by: 'user'; env: string }[];
  };
  effective: { configured: boolean; kind?: 'api' | 'cli' | null; provider: string | null; model: string | null; problem: string | null };
  /** 暂不能选择的 provider（如权限隔离还没确认的 opencode） */
  unavailableProviders?: LlmProvider[];
  autoReindex: boolean;
}

/** 附加环境变量的一项：只有代理变量和 *_BASE_URL 回传值；masked 表示值去掉了账号密码等，不是原值 */
export type ExtraEnvView = { name: string; value: string; masked?: true } | { name: string; set: true };

/** 保存时的附加环境变量；没有 value 表示沿用已保存的值 */
export interface ExtraEnvEntry {
  name: string;
  value?: string;
}

/** 保存和测试连接的表单：空字符串表示不保存（apiKey 为空表示不修改） */
export interface LlmForm {
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  clearApiKey: boolean;
  /** 只用于本机 CLI */
  command?: string;
  /** 只用于本机 CLI；完整列表，整体替换 */
  extraEnv?: ExtraEnvEntry[];
}

/** POST /api/settings/llm/test；本机 CLI 成功时给命令路径和版本，model 为空串表示工具默认模型 */
export type LlmTestResult =
  | { ok: true; provider: string; model: string; origin: string; ms: number }
  | { ok: true; provider: string; model: string; command: string; version: string; ms: number }
  | { ok: false; reason: string; message: string; ms: number };
