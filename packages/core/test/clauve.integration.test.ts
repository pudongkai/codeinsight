import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildSnapshot, callerSummaries, computeStructure, DEFAULT_PARTITION_THRESHOLDS, initDataDir, isHttpApi, loadGraphSide, loadConfig,
  loadPartitionInput, partition, runReview, setLogSink, similarInSnapshot, Store, structureReport,
} from '../src/index.js';
import type {
  CodeInsightConfig, DataDirLayout, DuplicateFinding, OverviewOptions, PartitionInput, ReviewReport, SnapshotRow, SymbolRow,
} from '../src/index.js';
import { fakeLlmEnv, overviewReply, startFakeLlm, type FakeLlm } from './helpers/fake-llm-server.mjs';
import { git, tempDir } from './helpers/git-repo.js';
import { overviewTasks, overviewWithEstimate } from './helpers/overview-run.js';

const CLAUVE = process.env.CODEINSIGHT_CLAUVE?.replace(/^~(?=$|\/)/, os.homedir());
const COMMIT = '80cf8e1';

interface Callers {
  prod: number;
  test: number;
}

/** 调用方按不同的调用函数计数 */
function callers(store: Store, snapshotId: number, target: SymbolRow, syms: Map<string, SymbolRow>): Callers {
  const srcIds = new Set(store.getEdgesForSymbols(snapshotId, [target.id], 'in', ['call']).map((e) => e.srcId));
  const srcs = [...srcIds].map((id) => syms.get(id)!);
  return { prod: srcs.filter((s) => !s.isTest).length, test: srcs.filter((s) => s.isTest).length };
}

const DUPLICATE_GROUPS = ['select_org_by_id', '_ensure_same_org', 'select_user_org_id', 'insert_lease'];

/** 某个名字的一组：查询函数和其中一个候选都叫这个名字 */
function hasSameNameGroup(findings: DuplicateFinding[], name: string): boolean {
  return findings.some((f) => f.symbol.name === name && f.candidates.some((c) => c.symbol.name === name));
}

describe.skipIf(!CLAUVE)('clauve integration (CODEINSIGHT_CLAUVE)', () => {
  it(`matches the verified caller counts and duplicate groups at ${COMMIT}`, async () => {
    const repo = path.resolve(CLAUVE!);
    const statusBefore = git(repo, 'status', '--porcelain');
    const config = await loadConfig(repo, { dataDir: tempDir('ci-clauve-'), env: {} });
    const layout = await initDataDir(config.dataDir);
    const store = new Store(layout.dbPath);
    try {
      const { snapshot } = await buildSnapshot({ repo, store, layout, config, ref: COMMIT });
      expect(snapshot).toMatchObject({ kind: 'commit', extractStatus: 'ok', resolverStatus: 'ok' });
      const syms = new Map(store.getSymbols(snapshot.id).map((s) => [s.id, s]));

      const audit = store.findSymbolsByName(snapshot.id, 'insert_audit_log').filter((s) => s.path === 'server/modules/lease/repository.py');
      expect(audit).toHaveLength(1);
      expect(callers(store, snapshot.id, audit[0]!, syms)).toEqual({ prod: 7, test: 0 });
      // 审查报告用的同一份调用方统计
      const side = loadGraphSide(store, snapshot);

      const release = store.findSymbolsByName(snapshot.id, 'select_release_by_version');
      expect(release).toHaveLength(1);
      expect(callers(store, snapshot.id, release[0]!, syms)).toEqual({ prod: 14, test: 16 });
      const summaries = callerSummaries(side, [audit[0]!.id, release[0]!.id]);
      expect(summaries.get(audit[0]!.id)).toMatchObject({ prod: 7, test: 0 });
      expect(summaries.get(release[0]!.id)).toMatchObject({ prod: 14, test: 16 });

      const prodToTest = store.getEdges(snapshot.id).filter((e) => !syms.get(e.srcId)!.isTest && syms.get(e.dstId)!.isTest);
      expect(prodToTest).toEqual([]);

      // similar --all 在同一个提交快照上：四组同名重复实现都要出现
      const { findings } = similarInSnapshot(store, snapshot.id, { minScore: config.similarMinScore });
      expect(DUPLICATE_GROUPS.filter((name) => !hasSameNameGroup(findings, name))).toEqual([]);
    } finally {
      store.close();
    }
    expect(git(repo, 'status', '--porcelain')).toBe(statusBefore);
  }, 600_000);
});

const ADMIN_API = 'server/console/modules/console/admin_api.py';

describe.skipIf(!CLAUVE)('clauve review fc4c752 (CODEINSIGHT_CLAUVE)', () => {
  const logLines: string[] = [];
  let restoreSink: ((line: string) => void) | undefined;
  const logLevel = process.env.CODEINSIGHT_LOG;
  beforeAll(() => {
    process.env.CODEINSIGHT_LOG = 'info';
    restoreSink = setLogSink((line) => logLines.push(line));
  });
  afterAll(() => {
    if (restoreSink) setLogSink(restoreSink);
    if (logLevel === undefined) delete process.env.CODEINSIGHT_LOG;
    else process.env.CODEINSIGHT_LOG = logLevel;
  });

  it('lists the 16 added admin_api.py functions, flags non-Python files, and reuses snapshots on the second review', async () => {
    const repo = path.resolve(CLAUVE!);
    const statusBefore = git(repo, 'status', '--porcelain');
    const config = await loadConfig(repo, { dataDir: tempDir('ci-clauve-review-'), env: {} });
    const layout = await initDataDir(config.dataDir);
    const review = async (): Promise<ReviewReport> => {
      const store = new Store(layout.dbPath);
      try {
        return await runReview({ repo, store, layout, config, base: 'fc4c752~1', head: 'fc4c752' });
      } finally {
        store.close();
      }
    };

    const report = await review();
    expect(report.warnings.filter((w) => w.code === 'resolver_failed')).toEqual([]);
    const admin = report.modules.flatMap((m) => m.symbols).filter((s) => s.path === ADMIN_API);
    expect(admin.filter((s) => s.change === 'added' && s.kind === 'function')).toHaveLength(16);

    const nonPython = report.files.filter((f) => !/\.pyi?$/.test(f.path));
    expect(nonPython.length).toBeGreaterThan(0);
    const flagged = new Set(report.warnings.filter((w) => w.code === 'language_unsupported').map((w) => w.path));
    for (const f of nonPython) {
      expect(f.supportLevel).toBe('none');
      expect(flagged.has(f.path)).toBe(true);
    }

    const before = logLines.length;
    const again = await review();
    const secondLogs = logLines.slice(before);
    expect(secondLogs.filter((l) => l.includes('snapshot_cache_hit'))).toHaveLength(2);
    expect(secondLogs.filter((l) => l.includes('scip_python_start'))).toEqual([]);
    expect(again.modules).toEqual(report.modules);
    expect(git(repo, 'status', '--porcelain')).toBe(statusBefore);
  }, 900_000);
});

/** 4.4 第 1 步列出的 clauve 80cf8e1 预期模块（默认阈值） */
const CLAUVE_MODULES = [
  'scripts', 'server/*', 'server/common', 'server/console', 'server/scripts',
  ...['account', 'auth', 'billing', 'credential', 'lease', 'mail', 'quota', 'release', 'usage_stats'].map((m) => `server/modules/${m}`),
].sort();

describe.skipIf(!CLAUVE)('clauve overview (CODEINSIGHT_CLAUVE)', () => {
  let repo: string;
  let statusBefore: string;
  let store: Store;
  let ctx: { layout: DataDirLayout; config: CodeInsightConfig; snapshot: SnapshotRow };
  beforeAll(async () => {
    repo = path.resolve(CLAUVE!);
    statusBefore = git(repo, 'status', '--porcelain');
    const config = await loadConfig(repo, { dataDir: tempDir('ci-clauve-partition-'), env: {} });
    const layout = await initDataDir(config.dataDir);
    store = new Store(layout.dbPath);
    const { snapshot } = await buildSnapshot({ repo, store, layout, config, ref: COMMIT });
    ctx = { layout, config, snapshot };
  }, 600_000);
  afterAll(() => {
    store?.close();
    if (repo) expect(git(repo, 'status', '--porcelain')).toBe(statusBefore);
  });

  it(`partitions ${COMMIT} into the 14 expected modules and gives the same result with its own record`, () => {
    const input = loadPartitionInput(store, ctx.snapshot.id);
    const first = partition({ ...input, thresholds: DEFAULT_PARTITION_THRESHOLDS, now: 1 });
    expect(first.modules.map((m) => m.id)).toEqual(CLAUVE_MODULES);
    for (const dir of ['server/modules/billing', 'server/modules/lease']) {
      const files = input.files.filter((f) => !f.isTest && f.path.startsWith(`${dir}/`)).map((f) => f.path);
      expect(files.length).toBeGreaterThan(0);
      expect(new Set(files.map((f) => first.index.byPath.get(f)))).toEqual(new Set([dir]));
    }
    // 所有参与划分的文件恰好属于一个模块；测试目录不在任何模块里
    const assigned = first.modules.flatMap((m) => m.files);
    expect(new Set(assigned).size).toBe(assigned.length);
    expect(assigned.length).toBe(first.stats.files);
    expect(assigned.some((f) => f.startsWith('server/tests/'))).toBe(false);
    // 没有计入规模的符号的非测试 Python 文件（18 个 __init__.py 和 server/database.py）都有归属
    expect(emptyPythonFiles(input).filter((f) => !first.index.byPath.has(f))).toEqual([]);
    expect(first.index.byPath.get('server/database.py')).toBe('server/*');

    const again = partition({ ...input, thresholds: DEFAULT_PARTITION_THRESHOLDS, record: first.record, now: 2 });
    expect(again.modules).toEqual(first.modules);
    expect(again.recordChanged).toBe(false);
  });

  it('finds external dependencies, groups every HTTP API into one feature, and reports boundary issues backed by edges', async () => {
    const s = await computeStructure({ repo, store, ...ctx });
    const report = structureReport(s, { repo, ref: COMMIT });
    const ext = (id: string) => Object.fromEntries(report.modules.find((m) => m.id === id)!.external.map((e) => [e.category, e.libs]));
    expect(ext('server/modules/billing').payment).toContain('stripe');
    expect(ext('server/modules/billing').database).toContain('psycopg');
    expect(ext('server/*').database).toContain('psycopg_pool');
    const serverRest = report.modules.find((m) => m.id === 'server/*')!;
    expect(serverRest.external.find((e) => e.category === 'database')!.files).toContain('server/database.py');
    const inModules = new Set(report.modules.flatMap((m) => m.files));
    expect(emptyPythonFiles(loadPartitionInput(store, ctx.snapshot.id)).filter((f) => !inModules.has(f))).toEqual([]);

    // 所有 HTTP 接口（不含 middleware）恰好各属于一个功能
    const syms = new Map(store.getSymbols(ctx.snapshot.id).map((x) => [x.id, x]));
    const apis = new Set(store.getEntries(ctx.snapshot.id).filter((e) => isHttpApi(e) && !syms.get(e.symbolId)!.isTest).map((e) => e.symbolId));
    const grouped = report.features.flatMap((f) => f.entries.filter((e) => isHttpApi(e.symbol.entry)).map((e) => e.symbol.id));
    expect(grouped.length).toBe(new Set(grouped).size);
    expect(new Set(grouped)).toEqual(apis);
    expect(report.stats.httpApis).toBe(apis.size);

    // 每条边界问题的示例调用点都能在 edges 表里找到
    const edgeKeys = new Set(store.getEdges(ctx.snapshot.id).map((e) => `${e.srcId}>${e.dstId}@${e.path}:${e.line}`));
    for (const issue of report.issues) {
      expect(issue.samples.length).toBeGreaterThan(0);
      for (const x of issue.samples) expect(edgeKeys.has(`${x.src.id}>${x.dst.id}@${x.path}:${x.line}`)).toBe(true);
    }
    const counts = Object.fromEntries(['cycle', 'layer_violation', 'layer_skip', 'private_access'].map((k) => [k, report.issues.filter((i) => i.kind === k).length]));
    expect(counts).toEqual(CLAUVE_ISSUE_COUNTS);
  }, 600_000);
});

/** 80cf8e1 上首次跑出、人工核对过的各类边界问题条数 */
const CLAUVE_ISSUE_COUNTS = { cycle: 1, layer_violation: 0, layer_skip: 1, private_access: 1 };

/** 没有计入规模的符号的非测试 Python 文件 */
function emptyPythonFiles(input: Pick<PartitionInput, 'files' | 'symbols'>): string[] {
  const sized = new Set(input.symbols.filter((s) => ['function', 'method', 'class'].includes(s.kind) && !s.isTest).map((s) => s.path));
  const empty = input.files.filter((f) => f.language === 'python' && !f.isTest && !f.isGenerated && !sized.has(f.path)).map((f) => f.path);
  expect(empty).toHaveLength(19);
  return empty;
}

const LEASE_API = 'server/modules/lease/api.py';

/** lease 的 heartbeat 处理函数加一次对 billing 的 ensure_org_enabled 的调用（连同 import） */
function addHeartbeatCall(source: string): string {
  const out = source
    .replace('from server.common.response import ok\n', 'from server.common.response import ok\nfrom server.modules.billing.access import ensure_org_enabled\n')
    .replace('    return ok(**service.heartbeat(req.model_dump(), operator))', '    ensure_org_enabled(operator["org_id"])\n    return ok(**service.heartbeat(req.model_dump(), operator))');
  expect(out.split('\n').length).toBe(source.split('\n').length + 2);
  return out;
}

describe.skipIf(!CLAUVE)('clauve overview with a fake LLM (CODEINSIGHT_CLAUVE)', () => {
  let fake: FakeLlm;
  let copy: string;
  let statusBefore: string;
  const stores: Store[] = [];
  const dataDir = tempDir('ci-clauve-ai-');
  const run = (ref?: string, extra: Partial<OverviewOptions> = {}) =>
    overviewWithEstimate(fake, { repo: copy, dataDir, env: fakeLlmEnv(fake.url), ...(ref ? { ref } : {}), extra, stores });
  beforeAll(async () => {
    statusBefore = git(path.resolve(CLAUVE!), 'status', '--porcelain');
    fake = await startFakeLlm({ reply: overviewReply });
    copy = tempDir('ci-clauve-copy-');
    git(copy, 'clone', '-q', '--no-checkout', path.resolve(CLAUVE!), '.');
    git(copy, 'checkout', '-q', COMMIT);
  }, 600_000);
  afterAll(async () => {
    for (const s of stores) s.close();
    await fake?.close();
    expect(git(path.resolve(CLAUVE!), 'status', '--porcelain')).toBe(statusBefore);
  });

  it('sends 24 requests, then none with --no-llm or a second run, then 3 after heartbeat calls billing', async () => {
    const first = await run(COMMIT);
    const tasks = overviewTasks(first.sent);
    expect(tasks.filter((t) => t.startsWith('module_summary:'))).toHaveLength(14);
    expect(tasks.filter((t) => t.startsWith('feature_naming:'))).toHaveLength(9);
    expect(tasks.filter((t) => t.startsWith('system_summary:'))).toHaveLength(1);
    expect(first.sent).toHaveLength(24);
    expect(first.est).toMatchObject({ modules: 14, llmCalls: 24, cachedCalls: 0 });
    expect(first.report.modules.every((m) => m.name === `模块-${m.id}`)).toBe(true);

    const noLlm = await run(COMMIT, { noLlm: true });
    expect(noLlm.sent).toHaveLength(0);
    expect(noLlm.report.modules.every((m) => m.aiStatus === 'cached' && m.name === `模块-${m.id}`)).toBe(true);
    const second = await run(COMMIT);
    expect(second.sent).toHaveLength(0);
    expect(second.est).toMatchObject({ llmCalls: 0, cachedCalls: 24 });

    writeFileSync(path.join(copy, LEASE_API), addHeartbeatCall(readFileSync(path.join(copy, LEASE_API), 'utf8')));
    const changed = await run();
    expect(overviewTasks(changed.sent)).toEqual(['feature_naming:server/modules/lease', 'module_summary:server/modules/lease', 'system_summary:']);
    expect(changed.est).toMatchObject({ llmCalls: 3, cachedCalls: 21 });
    expect(changed.report.modules.map((m) => [m.id, m.files])).toEqual(first.report.modules.map((m) => [m.id, m.files]));
    expect(changed.report.modules.find((m) => m.id === 'server/modules/billing')!.aiStatus).toBe('cached');
  }, 600_000);
});
