import { expect } from 'vitest';
import { buildSnapshot, estimateOverview, initDataDir, loadConfig, runOverview, Store } from '../../src/index.js';
import type { OverviewEstimate, OverviewOptions, OverviewReport } from '../../src/index.js';
import { overviewInput, type FakeLlm, type FakeLlmRequest } from './fake-llm-server.mjs';

export interface OverviewRun {
  est: OverviewEstimate;
  report: OverviewReport;
  id: number;
  /** 本次生成期间假 LLM 收到的请求 */
  sent: FakeLlmRequest[];
  store: Store;
}

export interface OverviewRunInput {
  repo: string;
  dataDir: string;
  env: Record<string, string>;
  /** 不传时用工作区快照 */
  ref?: string;
  extra?: Partial<OverviewOptions>;
  /** 打开的 Store 放进这里，由测试统一关闭 */
  stores: Store[];
}

/** 先估算（检查估算不发请求），再生成并保存 */
export async function overviewWithEstimate(fake: FakeLlm, input: OverviewRunInput): Promise<OverviewRun> {
  const config = await loadConfig(input.repo, { dataDir: input.dataDir, env: input.env });
  const layout = await initDataDir(config.dataDir);
  const store = new Store(layout.dbPath);
  input.stores.push(store);
  const { snapshot } = await buildSnapshot({ repo: input.repo, store, layout, config, ref: input.ref });
  const opts: OverviewOptions = { repo: input.repo, store, layout, config, snapshot, ref: input.ref ?? 'working', ...input.extra };
  const before = fake.requests.length;
  const est = await estimateOverview(opts);
  expect(fake.requests.length).toBe(before);
  const { id, report } = await runOverview(opts);
  return { est, report, id, sent: fake.requests.slice(before), store };
}

/** 请求的类别和对象（`module_summary:<id>` 等），排好序 */
export function overviewTasks(sent: FakeLlmRequest[]): string[] {
  return sent.map((r) => {
    const i = overviewInput(r)!;
    return `${i.task}:${i.module ?? i.group ?? ''}`;
  }).sort();
}
