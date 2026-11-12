import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildSnapshot, computeStructure, defaultModuleName, estimateOverview, estimateTokens, fitModuleInput, initDataDir, loadConfig, moduleInput,
  partitionRecordPath, Store,
} from '../src/index.js';
import type { ModuleSummaryInput, OverviewOptions, OverviewReport } from '../src/index.js';
import { overviewTasks, overviewWithEstimate, type OverviewRun } from './helpers/overview-run.js';
import { fakeLlmEnv, lastUserText, overviewInput, overviewReply, startFakeLlm, type FakeLlm, type FakeLlmReply, type FakeLlmRequest } from './helpers/fake-llm-server.mjs';
import { commitAll, git, tempDir, writeFiles } from './helpers/git-repo.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'py-shop');
const SMALL = { moduleMinSize: 3, moduleMaxSize: 15, leafSplitSize: 8 };

let fake: FakeLlm;
let mode: (req: FakeLlmRequest) => FakeLlmReply = overviewReply;
const stores: Store[] = [];
beforeAll(async () => {
  fake = await startFakeLlm({ reply: (r) => mode(r) });
});
afterAll(async () => {
  for (const s of stores) s.close();
  await fake.close();
});

function shopRepo(): string {
  const repo = tempDir('ci-ai-shop-');
  cpSync(FIXTURE, repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  commitAll(repo, 'init');
  writeFileSync(path.join(repo, 'codeinsight.config.json'), JSON.stringify({ overview: SMALL }));
  return repo;
}

/** env 不传时用假 LLM 的环境变量 */
function overview(repo: string, dataDir: string, extra: Partial<OverviewOptions> = {}, env: Record<string, string> = fakeLlmEnv(fake.url)): Promise<OverviewRun> {
  return overviewWithEstimate(fake, { repo, dataDir, env, extra, stores });
}

const mod = (r: OverviewReport, id: string) => r.modules.find((m) => m.id === id)!;
const featureModules = (r: OverviewReport) => new Set(r.features.map((f) => f.module)).size;

describe('overview AI part on py-shop', () => {
  const repo = shopRepo();
  const dataDir = tempDir('ci-ai-data-');
  let total = 0;

  it('sends one request per module, per module with entries and one for the system, as estimated', async () => {
    mode = overviewReply;
    const r = await overview(repo, dataDir);
    const n = r.report.modules.length;
    total = n + featureModules(r.report) + 1;
    expect(r.sent).toHaveLength(total);
    expect(r.est).toMatchObject({ modules: n, llmCalls: total, cachedCalls: 0, provider: 'anthropic', sendSource: true, needsConfirm: false });
    expect(r.est.inputTokens).toBeGreaterThan(0);
    expect(r.report.ai).toMatchObject({ calls: total, cached: 0, failed: 0 });
    for (const m of r.report.modules) expect(m).toMatchObject({ name: `模块-${m.id}`, responsibility: `负责 ${m.id}`, aiStatus: 'ok' });
    expect(r.report.features.every((f) => f.name.startsWith('功能-') && f.description)).toBe(true);
    expect(r.report.system?.title).toBe('系统简介');
    expect(r.report.llm).toMatchObject({ provider: 'anthropic', sendSource: true });
    expect(r.store.overviews.get(r.id)).toMatchObject({ status: 'done', hasLlm: true });
    expect(existsSync(partitionRecordPath(dataDir))).toBe(true);
    // 请求里没有行号，带源码片段
    for (const req of r.sent) expect(JSON.stringify(overviewInput(req))).not.toMatch(/"(line|startLine|endLine)"/);
    const inputs = r.sent.map((x) => overviewInput(x)!).filter((i) => i.task === 'module_summary');
    expect(inputs.some((i) => (i.snippets as unknown[]).length > 0)).toBe(true);
  });

  it('hits the cache for every request on the second run, with the previous names in the prompt', async () => {
    const r = await overview(repo, dataDir);
    expect(r.sent).toHaveLength(0);
    expect(r.est).toMatchObject({ llmCalls: 0, cachedCalls: total });
    expect(r.report.ai).toMatchObject({ calls: 0, cached: total });
    for (const m of r.report.modules) expect(m).toMatchObject({ name: `模块-${m.id}`, aiStatus: 'cached' });
    expect(r.report.system?.title).toBe('系统简介');
  });

  it('sends nothing with noLlm, and finds cached names through the last named overview when no LLM is configured', async () => {
    const noLlm = await overview(repo, dataDir, { noLlm: true });
    expect(noLlm.sent).toHaveLength(0);
    expect(noLlm.report.modules.every((m) => m.aiStatus === 'cached' && m.name === `模块-${m.id}`)).toBe(true);
    expect(noLlm.report.warnings.map((w) => w.code)).toContain('llm_disabled');
    const unconfigured = await overview(repo, dataDir, {}, {});
    expect(unconfigured.sent).toHaveLength(0);
    expect(unconfigured.est).toMatchObject({ llmCalls: 0, cachedCalls: total });
    expect(unconfigured.report.modules.every((m) => m.aiStatus === 'cached')).toBe(true);
    expect(unconfigured.report.warnings.map((w) => w.code)).toContain('llm_not_configured');
    expect(unconfigured.report.llm?.provider).toBe('anthropic');
  });

  it('only requests the changed module, its features and the system after it starts calling another module', async () => {
    const api = path.join(repo, 'app/users/api.py');
    writeFiles(repo, { 'app/users/api.py': readFileSync(api, 'utf8')
      .replace('from app.users import service', 'from app.common import utils\nfrom app.users import service')
      .replace('    return UserOut(**service.get_user(user_id))', '    utils.slugify("x")\n    return UserOut(**service.get_user(user_id))') });
    const r = await overview(repo, dataDir);
    const users = r.report.modules.find((m) => m.files.includes('app/users/api.py'))!;
    expect(overviewTasks(r.sent)).toEqual([`feature_naming:${users.id}`, `module_summary:${users.id}`, 'system_summary:'].sort());
    expect(r.est).toMatchObject({ llmCalls: 3, cachedCalls: total - 3 });
    expect(r.report.ai).toMatchObject({ calls: 3, cached: total - 3 });
    const modulePrompt = lastUserText(r.sent.find((x) => overviewInput(x)!.task === 'module_summary')!);
    expect(modulePrompt).toContain(`previous name of this module was "模块-${users.id}"`);
    const common = r.report.modules.find((m) => m.files.includes('app/common/utils.py'))!;
    expect(common.aiStatus).toBe('cached');

    // 再改一次后 --no-llm：未命中的模块用目录名，其他照样有名称
    writeFiles(repo, { 'app/users/api.py': readFileSync(api, 'utf8').replace('utils.slugify("x")', 'utils.slugify("y")') });
    const noLlm = await overview(repo, dataDir, { noLlm: true });
    expect(noLlm.sent).toHaveLength(0);
    expect(mod(noLlm.report, users.id)).toMatchObject({ name: defaultModuleName(users.id), aiStatus: 'none' });
    expect(mod(noLlm.report, common.id)).toMatchObject({ name: `模块-${common.id}`, aiStatus: 'cached' });
  });
});

describe('overview AI inputs stay local to each module', () => {
  it('does not re-request a module when another module starts using its data models', async () => {
    mode = overviewReply;
    const repo = shopRepo();
    const dataDir = tempDir('ci-ai-models-');
    const first = await overview(repo, dataDir);
    const orders = first.report.modules.find((m) => m.files.includes('app/orders/api.py'))!;
    expect(orders.models.map((x) => x.symbol.name)).toEqual(['OrderOut', 'OrderIn']);
    // users 新增两处对 OrderIn 的引用：全局引用数让展示顺序翻转，但 orders 的摘要输入不变
    const service = path.join(repo, 'app/users/service.py');
    writeFiles(repo, { 'app/users/service.py': `${readFileSync(service, 'utf8')}\n\nfrom app.orders.api import OrderIn\n\n\ndef draft_a():\n    return OrderIn(sku="a", qty=1)\n\n\ndef draft_b():\n    return OrderIn(sku="b", qty=2)\n` });
    const r = await overview(repo, dataDir);
    const users = r.report.modules.find((m) => m.files.includes('app/users/service.py'))!;
    expect(mod(r.report, orders.id).models.map((x) => x.symbol.name)).toEqual(['OrderIn', 'OrderOut']);
    expect(overviewTasks(r.sent)).toEqual([`module_summary:${users.id}`, 'system_summary:']);
    expect(mod(r.report, orders.id).aiStatus).toBe('cached');
  });
});

describe('system introduction for more than 60 modules', () => {
  const MANY = { moduleMinSize: 1, moduleMaxSize: 2, leafSplitSize: 1000 };
  function manyModulesRepo(): string {
    const files: Record<string, string> = { 'codeinsight.config.json': JSON.stringify({ overview: MANY }) };
    for (const g of ['g1', 'g2']) for (let i = 0; i < 31; i++) files[`${g}/m${String(i).padStart(2, '0')}/f.py`] = `def f${i}():\n    return ${i}\n`;
    const repo = tempDir('ci-ai-many-');
    writeFiles(repo, files);
    git(repo, 'init', '-q', '-b', 'main');
    commitAll(repo, 'init');
    return repo;
  }

  it('summarizes top-level groups first; a failed group leaves the system introduction empty until the next run', async () => {
    const repo = manyModulesRepo();
    const dataDir = tempDir('ci-ai-many-data-');
    mode = (req) => (overviewInput(req)?.group === 'g2' ? { status: 400, errorType: 'invalid_request_error' } : overviewReply(req));
    const failed = await overview(repo, dataDir);
    mode = overviewReply;
    expect(failed.report.modules).toHaveLength(62);
    expect(failed.est.llmCalls).toBe(62 + 2 + 1);
    expect(overviewTasks(failed.sent).filter((t) => !t.startsWith('module_summary:'))).toEqual(['group_summary:g1', 'group_summary:g2']);
    expect(failed.report.system).toBeUndefined();
    expect(failed.report.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['llm_failed', 'overview_system_failed']));

    const again = await overview(repo, dataDir);
    expect(overviewTasks(again.sent)).toEqual(['group_summary:g2', 'system_summary:']);
    const system = overviewInput(again.sent.find((x) => overviewInput(x)!.task === 'system_summary')!)!;
    expect(system.modules).toBeUndefined();
    expect((system.groups as { group: string; title: string }[]).map((g) => [g.group, g.title])).toEqual([['g1', '分组-g1'], ['g2', '分组-g2']]);
    expect(again.report.system?.title).toBe('系统简介');
  });
});

describe('overview AI failures', () => {
  const sequence = (replies: FakeLlmReply[]) => {
    let i = 0;
    return (req: FakeLlmRequest) => (i < replies.length ? replies[i++]! : overviewReply(req));
  };
  const serial = { ...fakeLlmEnv(''), CODEINSIGHT_OVERVIEW_CONCURRENCY: '1' };

  it('retries 429 after retry-after and an invalid JSON reply once', async () => {
    mode = sequence([{ status: 429, headers: { 'retry-after': '0' }, errorType: 'rate_limit_error' }, 'not json']);
    const r = await overview(shopRepo(), tempDir('ci-ai-retry-'), {}, { ...serial, CODEINSIGHT_LLM_BASE_URL: fake.url });
    expect(r.sent).toHaveLength(r.est.llmCalls + 2);
    expect(r.report.ai.failed).toBe(0);
    expect(r.report.modules.every((m) => m.aiStatus === 'ok')).toBe(true);
    mode = overviewReply;
  });

  it('stops sending after more than half of at least 5 requests failed', async () => {
    mode = () => ({ status: 400, errorType: 'invalid_request_error' });
    const r = await overview(shopRepo(), tempDir('ci-ai-abort-'), {}, { ...serial, CODEINSIGHT_LLM_BASE_URL: fake.url });
    mode = overviewReply;
    expect(r.report.modules.length).toBeGreaterThan(5);
    expect(r.sent).toHaveLength(5);
    expect(r.report.modules.filter((m) => m.aiStatus === 'failed')).toHaveLength(5);
    expect(r.report.modules.slice(5).every((m) => m.aiStatus === 'skipped' && !m.responsibility)).toBe(true);
    expect(r.report.system).toBeUndefined();
    expect(r.report.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['llm_aborted', 'overview_system_failed']));
    expect(r.store.overviews.get(r.id)).toMatchObject({ status: 'done', hasLlm: false });
    expect(r.report.llm).toBeUndefined();
  });

  it('sends no source snippets or model bodies with noSource', async () => {
    mode = overviewReply;
    const r = await overview(shopRepo(), tempDir('ci-ai-nosrc-'), { noSource: true });
    expect(r.est.sendSource).toBe(false);
    expect(r.sent.length).toBeGreaterThan(0);
    for (const req of r.sent) {
      const input = overviewInput(req)!;
      expect(input.snippets).toBeUndefined();
      if (input.task === 'module_summary') expect((input.models as { head?: string }[]).every((x) => x.head === undefined)).toBe(true);
    }
    expect(r.report.llm?.sendSource).toBe(false);
  });

  it('does not write the partition record or an overview row when only estimating', async () => {
    const repo = shopRepo();
    const dataDir = tempDir('ci-ai-est-');
    const config = await loadConfig(repo, { dataDir, env: fakeLlmEnv(fake.url) });
    const layout = await initDataDir(config.dataDir);
    const store = new Store(layout.dbPath);
    stores.push(store);
    const { snapshot } = await buildSnapshot({ repo, store, layout, config });
    const est = await estimateOverview({ repo, store, layout, config, snapshot, ref: 'working' });
    expect(est.llmCalls).toBeGreaterThan(0);
    expect(existsSync(partitionRecordPath(dataDir))).toBe(false);
    expect(store.overviews.list()).toEqual([]);
  });
});

describe('module summary input', () => {
  it('keeps the top 60 public symbols: HTTP handlers, then in-module callers, then key', async () => {
    const funcs = Array.from({ length: 70 }, (_, i) => `def f${String(i).padStart(2, '0')}():\n    ${i < 3 ? 'return helper_a()' : i === 3 ? 'return helper_b()' : 'return 1'}\n`);
    const repo = tempDir('ci-ai-rank-');
    writeFiles(repo, {
      'svc/__init__.py': '',
      'svc/funcs.py': ['def helper_a():\n    return 1\n', 'def helper_b():\n    return 2\n', 'def _private():\n    return 3\n', ...funcs].join('\n\n'),
      'svc/api.py': 'from fastapi import APIRouter\n\nrouter = APIRouter()\n\n\n@router.get("/zz")\ndef zz_handler():\n    return {}\n',
    });
    git(repo, 'init', '-q', '-b', 'main');
    commitAll(repo, 'init');
    const config = await loadConfig(repo, { dataDir: tempDir('ci-ai-rank-data-'), env: {} });
    const layout = await initDataDir(config.dataDir);
    const store = new Store(layout.dbPath);
    stores.push(store);
    const { snapshot } = await buildSnapshot({ repo, store, layout, config });
    const s = await computeStructure({ repo, store, layout, snapshot, config });
    const m = s.modules.find((x) => x.files.includes('svc/funcs.py'))!;
    const input = moduleInput(s, m, true);
    const names = input.symbols.map((x) => x.key.split('#')[2]);
    const rest = Array.from({ length: 57 }, (_, i) => `f${String(i).padStart(2, '0')}`);
    expect(names).toEqual(['zz_handler', 'helper_a', 'helper_b', ...rest]);
    expect(input.symbols[0]).toMatchObject({ method: 'GET', path: '/zz' });
  });

  it('drops called symbols, then snippets, then models, then public symbols when over the token budget', () => {
    const big = 'x'.repeat(400);
    const input: ModuleSummaryInput = {
      task: 'module_summary', module: 'm', dirs: ['m'], files: ['m/a.py'], size: 1,
      symbols: Array.from({ length: 10 }, (_, i) => ({ key: `m/a.py#function#s${i}#`, signature: '()' })),
      models: Array.from({ length: 3 }, (_, i) => ({ key: `m/a.py#class#M${i}#`, head: big })),
      calls: [{ module: 'n', keys: Array.from({ length: 20 }, (_, i) => `n/b.py#function#c${i}#`) }],
      external: [], envVars: [],
      snippets: Array.from({ length: 4 }, (_, i) => ({ key: `m/a.py#function#s${i}#`, code: big })),
    };
    expect(fitModuleInput(structuredClone(input), 1_000_000)).toBe(false);
    const budget = estimateTokens(JSON.stringify({ ...input, calls: [], snippets: [] }));
    const fitted = structuredClone(input);
    expect(fitModuleInput(fitted, budget)).toBe(true);
    expect(fitted.calls).toEqual([]);
    expect(fitted.snippets).toEqual([]);
    expect(fitted.models).toHaveLength(3);
    expect(fitted.symbols).toHaveLength(10);
  });
});
