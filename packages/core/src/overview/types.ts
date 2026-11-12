/**
 * 系统概览 JSON（OverviewReport）：CLI、HTTP、MCP、Web UI 共用。
 * 本文件只有类型，不依赖 Node 模块，web 可以直接引用 `@codeinsight/core/overview/types`。
 * 报告里的行号（SymbolRef.startLine、samples.line）只用于展示和跳转，不进 LLM 输入。
 */
import type { EntryKind } from '../model/types.js';
import type { SymbolRef, Warning } from '../report/types.js';

export type Layer = 'entry' | 'service' | 'data' | 'common';

export type ExternalCategory =
  | 'database' | 'cache' | 'http_client' | 'message_queue' | 'email' | 'payment'
  | 'storage' | 'auth_crypto' | 'llm' | 'web_framework' | 'subprocess' | 'other';

/** 模块 AI 说明的来源：ok 本次请求、cached 缓存命中、none 没有请求（未配置或 noLlm 未命中） */
export type ModuleAiStatus = 'ok' | 'cached' | 'failed' | 'skipped' | 'truncated' | 'none';

export interface ModuleInterface {
  symbol: SymbolRef;
  /** 其他模块里调用或引用它的不同符号数 */
  inbound: number;
  fromModules: string[];
  summary?: string;
}

export interface ModuleModel {
  symbol: SymbolRef;
  summary?: string;
}

export interface ModuleExternal {
  category: ExternalCategory;
  libs: string[];
  files: string[];
}

export interface ModuleEnvVar {
  name: string;
  files: string[];
}

export interface OverviewModule {
  /** 见模块划分，如 `server/modules/billing`、`server/*`、`app/big#a` */
  id: string;
  dirs: string[];
  files: string[];
  /** 非测试的 function、method、class 数 */
  size: number;
  lines: number;
  /** HTTP 接口数（不含中间件和测试；interfaces 只列前 30 个，统计用这个） */
  httpApis: number;
  /** LLM 起的名字；没有时为目录名 */
  name: string;
  responsibility?: string;
  aiStatus: ModuleAiStatus;
  /** 最多 30 个 */
  interfaces: ModuleInterface[];
  /** 最多 30 个 */
  models: ModuleModel[];
  external: ModuleExternal[];
  envVars: ModuleEnvVar[];
  /** 层 → 文件 */
  layers: Partial<Record<Layer, string[]>>;
}

export interface ExternalCategorySummary {
  category: ExternalCategory;
  libs: string[];
  modules: string[];
}

export interface EdgeSample {
  src: SymbolRef;
  dst: SymbolRef;
  path: string;
  line: number;
}

export type ModuleEdgeKind = 'call' | 'reference' | 'import';

export interface ModuleEdge {
  from: string;
  to: string;
  /** call + reference 边里不同的 (调用方, 被调用方) 符号对数；只有 import 时为 0 */
  weight: number;
  kinds: ModuleEdgeKind[];
  /** 最多 5 个，只取 call / reference */
  samples: EdgeSample[];
  inCycle: boolean;
}

export interface FeatureEntry {
  symbol: SymbolRef;
  kind: EntryKind;
  method?: string;
  path?: string;
}

export interface Feature {
  /** 模块 id + 组内排序后第一个入口的符号 id */
  id: string;
  module: string;
  /** LLM 起的名字；没有时为默认分组名 */
  name: string;
  description?: string;
  entries: FeatureEntry[];
}

export type BoundaryIssueKind = 'cycle' | 'layer_violation' | 'layer_skip' | 'private_access';

export interface BoundaryIssue {
  kind: BoundaryIssueKind;
  severity: 'warning' | 'info';
  modules: string[];
  message: string;
  /** 最多 10 个 */
  samples: EdgeSample[];
}

export interface OverviewStats {
  files: number;
  testFiles: number;
  modules: number;
  functions: number;
  httpApis: number;
  models: number;
}

export interface OverviewAiStats {
  calls: number;
  cached: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
}

export const OVERVIEW_SCHEMA_VERSION = 1;

export interface OverviewReport {
  schemaVersion: 1;
  repo: string;
  ref: string;
  snapshot: { contentKey: string; commitSha: string; kind: 'commit' | 'working'; createdAt: number };
  generatedAt: number;
  /** 不用 LLM 时不存在 */
  llm?: { provider: string; model: string; sendSource: boolean };
  system?: { title: string; summary: string };
  stats: OverviewStats;
  modules: OverviewModule[];
  moduleEdges: ModuleEdge[];
  /** 全项目按类别汇总 */
  external: ExternalCategorySummary[];
  features: Feature[];
  issues: BoundaryIssue[];
  ai: OverviewAiStats;
  warnings: Warning[];
}
