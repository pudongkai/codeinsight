import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDataDir, partitionRecordPath } from '@codeinsight/core';
import type { OverviewEstimate, OverviewReport } from '@codeinsight/core';
import { runCli } from '../src/cli.js';
import { fakeLlmEnv, overviewReply, startFakeLlm, type FakeLlm } from '../../core/test/helpers/fake-llm-server.mjs';
import { commitAll, git } from '../../core/test/helpers/git-repo.js';

const FIXTURE = path.resolve(import.meta.dirname, '..', '..', 'core', 'test', 'fixtures', 'py-shop');
const WORKER = path.resolve(import.meta.dirname, '..', '..', 'core', 'test', 'helpers', 'overview-worker.mjs');
const LLM_VARS = ['CODEINSIGHT_LLM_PROVIDER', 'CODEINSIGHT_LLM_MODEL', 'CODEINSIGHT_LLM_API_KEY', 'CODEINSIGHT_LLM_BASE_URL'];

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function shopRepo(): string {
  const repo = tempDir('ci-cli-ov-');
  cpSync(FIXTURE, repo, { recursive: true });
  writeFileSync(path.join(repo, 'codeinsight.config.json'), JSON.stringify({ overview: { moduleMinSize: 3, moduleMaxSize: 15, leafSplitSize: 8 } }));
  git(repo, 'init', '-q', '-b', 'main');
  commitAll(repo, 'init');
  return repo;
}

/** 在进程内运行 CLI，收集 stdout 和 stderr */
async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((out += String(chunk)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => ((err += String(chunk)), true));
  try {
    return { code: await runCli(argv), out, err };
  } finally {
    vi.restoreAllMocks();
  }
}

let fake: FakeLlm;
beforeAll(async () => {
  process.env.CODEINSIGHT_LOG = 'silent';
  for (const k of [...LLM_VARS, 'CODEINSIGHT_DATA_DIR', 'CODEINSIGHT_SEND_SOURCE', 'CODEINSIGHT_OVERVIEW_CONFIRM_TOKENS']) delete process.env[k];
  fake = await startFakeLlm({ reply: overviewReply });
  Object.assign(process.env, fakeLlmEnv(fake.url));
});
afterAll(() => fake.close());
afterEach(() => vi.restoreAllMocks());

describe('codeinsight overview', () => {
  const repo = shopRepo();
  const dataDir = tempDir('ci-cli-ov-data-');
  const args = ['--repo', repo, '--data-dir', dataDir];

  it('--estimate sends nothing and does not write the partition record', async () => {
    const before = fake.requests.length;
    const r = await cli('overview', '--estimate', ...args);
    expect(r.code).toBe(0);
    const est = JSON.parse(r.out) as OverviewEstimate;
    expect(est).toMatchObject({ provider: 'anthropic', sendSource: true, cachedCalls: 0, needsConfirm: false });
    expect(est.llmCalls).toBeGreaterThan(est.modules);
    expect(fake.requests.length).toBe(before);
    expect(existsSync(partitionRecordPath(dataDir))).toBe(false);
  });

  it('--format json generates the system introduction and module names', async () => {
    const before = fake.requests.length;
    const r = await cli('overview', '--format', 'json', ...args);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as OverviewReport;
    expect(report.system?.title).toBe('系统简介');
    expect(report.modules.every((m) => m.name === `模块-${m.id}`)).toBe(true);
    expect(fake.requests.length - before).toBe(report.ai.calls);
    expect(r.err).toContain('sending structural information and source snippets to anthropic');
    expect(existsSync(partitionRecordPath(dataDir))).toBe(true);
  });

  it('--no-llm sends nothing and keeps the cached module names', async () => {
    const before = fake.requests.length;
    const out = path.join(tempDir('ci-cli-ov-out-'), 'overview.md');
    const r = await cli('overview', '--no-llm', '--format', 'md', '--out', out, ...args);
    expect(r.code).toBe(0);
    expect(fake.requests.length).toBe(before);
    const md = readFileSync(out, 'utf8');
    expect(md).toContain('# 系统简介');
    expect(md).toContain('模块-app/orders');
  });
});

describe('codeinsight overview confirmation and conflicts', () => {
  it('exits 2 without --yes when the estimate exceeds confirmTokens, and generates with --yes', async () => {
    const args = ['--repo', shopRepo(), '--data-dir', tempDir('ci-cli-ov-confirm-')];
    process.env.CODEINSIGHT_OVERVIEW_CONFIRM_TOKENS = '10';
    try {
      const before = fake.requests.length;
      const out = path.join(tempDir('ci-cli-ov-confirm-out-'), 'overview.json');
      writeFileSync(out, 'previous report');
      const r = await cli('overview', '--out', out, ...args);
      expect(r.code).toBe(2);
      // 估算只写 stderr，--out 里原来的报告不被覆盖
      expect(r.out).toBe('');
      expect(readFileSync(out, 'utf8')).toBe('previous report');
      expect(r.err).toContain('"needsConfirm": true');
      expect(r.err).toContain('--yes');
      expect(fake.requests.length).toBe(before);
      const yes = await cli('overview', '--yes', '--out', out, ...args);
      expect(yes.code).toBe(0);
      expect(fake.requests.length).toBeGreaterThan(before);
      expect((JSON.parse(readFileSync(out, 'utf8')) as OverviewReport).system?.title).toBe('系统简介');
    } finally {
      delete process.env.CODEINSIGHT_OVERVIEW_CONFIRM_TOKENS;
    }
  });

  it('exits 1 while another process holds a running overview', async () => {
    const dataDir = tempDir('ci-cli-ov-busy-');
    const { dbPath } = await initDataDir(dataDir);
    const child = spawn(process.execPath, [WORKER, dbPath, '20000'], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      const started = await new Promise<{ pid: number; ok: boolean }>((resolve) => child.stdout.once('data', (d: Buffer) => resolve(JSON.parse(d.toString()))));
      expect(started.ok).toBe(true);
      const r = await cli('overview', '--repo', shopRepo(), '--data-dir', dataDir);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`already being generated (pid ${started.pid})`);
    } finally {
      child.kill();
    }
  });

  it('generates the structure with llm_not_configured when no LLM is configured', async () => {
    const saved = Object.fromEntries(LLM_VARS.map((k) => [k, process.env[k]]));
    for (const k of LLM_VARS) delete process.env[k];
    try {
      const before = fake.requests.length;
      const r = await cli('overview', '--repo', shopRepo(), '--data-dir', tempDir('ci-cli-ov-nollm-'));
      expect(r.code).toBe(0);
      const report = JSON.parse(r.out) as OverviewReport;
      expect(report.warnings.map((w) => w.code)).toContain('llm_not_configured');
      expect(report.modules.length).toBeGreaterThan(0);
      expect(report.modules.every((m) => m.aiStatus === 'none')).toBe(true);
      expect(report.llm).toBeUndefined();
      expect(fake.requests.length).toBe(before);
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    }
  });
});
