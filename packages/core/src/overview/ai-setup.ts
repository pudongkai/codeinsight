import { effectiveSendSource, type CodeInsightConfig } from '../config/index.js';
import { llmIdentity } from '../llm/cache.js';
import type { LlmClient } from '../llm/index.js';
import { llmClientFromConfig } from '../llm/setup.js';
import type { SnapshotRow } from '../model/types.js';
import type { Warning } from '../report/types.js';
import { readSnapshotFile } from '../snapshot/source.js';
import type { DataDirLayout } from '../store/data-dir.js';
import type { Store } from '../store/db.js';
import type { SummarizeOptions } from './summarize.js';
import type { OverviewReport } from './types.js';

export interface OverviewOptions {
  repo: string;
  store: Store;
  layout: DataDirLayout;
  config: CodeInsightConfig;
  snapshot: SnapshotRow;
  /** 用户给的 ref 原文；工作区为 `working` */
  ref: string;
  /** 不发送任何请求，只用缓存里的说明 */
  noLlm?: boolean;
  /** 本次不发送源码；配置里已关闭时不能用它打开 */
  noSource?: boolean;
  /** 测试注入，替代按配置创建的客户端 */
  llmClient?: LlmClient;
  onLlmNotice?: (message: string) => void;
  /** 中止生成：不再发送请求，记录标为 failed，不保存概览 */
  signal?: AbortSignal;
}

/** 本次生成用的 LLM 身份和发送设置 */
export interface OverviewAiSetup {
  /** 只在会发送请求时有（配置了 LLM 且不是 noLlm） */
  client?: LlmClient;
  /** 缓存身份：当前 LLM 配置，没有配置时取最近一条带 AI 说明的记录的身份 */
  identity?: string;
  provider?: string;
  model?: string;
  sendSource: boolean;
  /** 上一次带 AI 说明的概览（稳定命名） */
  previous?: OverviewReport;
  warnings: Warning[];
}

function setupWarnings(opts: OverviewOptions, problem: Warning | undefined, configured: boolean): Warning[] {
  if (opts.noLlm) return [{ code: 'llm_disabled', level: 'info', message: 'AI descriptions: --no-llm, no requests sent; only cached descriptions are used' }];
  if (problem) return [problem];
  if (configured) return [];
  return [{ code: 'llm_not_configured', level: 'info', message: 'AI descriptions skipped: no LLM configured (set CODEINSIGHT_LLM_PROVIDER, or llm in codeinsight.config.json); only cached descriptions are used' }];
}

/** 解析 LLM 客户端、缓存身份、上一次的概览和源码开关 */
export function overviewAiSetup(opts: OverviewOptions): OverviewAiSetup {
  const sendSource = effectiveSendSource(opts.config, opts.noSource);
  const previous = opts.store.overviews.lastNamed(opts.snapshot.kind)?.result ?? undefined;
  const c = llmClientFromConfig(opts.config, { client: opts.llmClient, skipped: 'AI descriptions skipped' });
  const client = c && 'client' in c ? c.client : undefined;
  const warnings = setupWarnings(opts, c && 'warning' in c ? c.warning : undefined, client !== undefined);
  if (client) {
    return { ...(opts.noLlm ? {} : { client }), identity: llmIdentity(client), provider: client.provider, model: client.model, sendSource, previous, warnings };
  }
  // 缓存身份不限快照类型：任何一次带 AI 说明的生成用的 LLM 都可以
  const p = opts.store.overviews.lastNamedParams();
  return { identity: p?.llmIdentity, provider: p?.provider, model: p?.model, sendSource, previous, warnings };
}

export function summarizeOptions(opts: OverviewOptions, setup: OverviewAiSetup): SummarizeOptions {
  const { repo, store, layout, snapshot, config } = opts;
  return {
    ...(setup.client ? { client: setup.client } : {}), ...(setup.identity ? { identity: setup.identity } : {}),
    cacheDir: layout.llmCacheDir, language: config.overview.language, sendSource: setup.sendSource, concurrency: config.overview.concurrency,
    ...(setup.previous ? { previous: setup.previous } : {}),
    readFile: (p) => readSnapshotFile({ repo, store, layout }, snapshot, p),
    ...(opts.onLlmNotice ? { onLlmNotice: opts.onLlmNotice } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
}
