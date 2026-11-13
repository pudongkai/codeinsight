import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataDirLayout, resetCliShutdown, Store } from '@codeinsight/core';
import { runCli } from '../src/cli.js';
import { MCP_USAGE } from '../src/commands/mcp.js';
import { commitAll, git } from '../../core/test/helpers/git-repo.js';
import { tempHomeEnv } from './setup-home.js';

const FIXTURE = path.resolve(import.meta.dirname, '..', '..', 'core', 'test', 'fixtures', 'py-shop');
const FAKE_CLAUDE = path.resolve(import.meta.dirname, '..', '..', 'core', 'test', 'helpers', 'fake-claude.mjs');
const MAIN = path.resolve(import.meta.dirname, '..', 'dist', 'main.js');
const VARS = ['CODEINSIGHT_LLM_PROVIDER', 'CODEINSIGHT_LLM_MODEL', 'CODEINSIGHT_LLM_API_KEY', 'CODEINSIGHT_LLM_BASE_URL', 'CODEINSIGHT_LLM_COMMAND', 'CODEINSIGHT_DATA_DIR'];

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function shopRepo(): string {
  const repo = tempDir('ci-cli-ask-cli-');
  cpSync(FIXTURE, repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  commitAll(repo, 'init');
  return repo;
}

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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
}

let recordFile = '';
const records = (): { pid: number; scenario?: string }[] =>
  existsSync(recordFile) ? readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { pid: number }) : [];

function scenario(name: string): Record<string, string> {
  recordFile = path.join(tempDir('ci-cli-rec-'), 'record.jsonl');
  return { FAKE_CLI_SCENARIO: name, FAKE_CLI_RECORD: recordFile };
}

const repo = shopRepo();
const dataDir = tempDir('ci-cli-ask-cli-data-');
const claudeConfigDir = tempDir('ci-claude-cfg-');
const LLM_ENV = { CODEINSIGHT_LLM_PROVIDER: 'claude-code', CODEINSIGHT_LLM_COMMAND: FAKE_CLAUDE, CLAUDE_CONFIG_DIR: claudeConfigDir };

/** 用 dist 起一个子进程，环境只有 PATH、临时用户目录、LLM 配置和假 CLI 的场景 */
function spawnCli(args: string[], extra: Record<string, string>): ChildProcess {
  return spawn(process.execPath, [MAIN, ...args], {
    env: { PATH: process.env.PATH ?? '', CODEINSIGHT_LOG: 'silent', ...tempHomeEnv(), ...LLM_ENV, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const exited = (child: ChildProcess) => new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));

beforeAll(() => {
  process.env.CODEINSIGHT_LOG = 'silent';
  chmodSync(FAKE_CLAUDE, 0o755);
  for (const k of VARS) delete process.env[k];
  Object.assign(process.env, LLM_ENV);
});
beforeEach(() => resetCliShutdown());
afterAll(() => {
  for (const k of [...VARS, 'CLAUDE_CONFIG_DIR', 'FAKE_CLI_SCENARIO', 'FAKE_CLI_RECORD']) delete process.env[k];
});

describe('codeinsight ask with a local CLI', () => {
  it('prints the answer from the fake claude and the tool calls to stderr', async () => {
    Object.assign(process.env, scenario('stream'));
    const r = await cli('ask', '退款流程怎么走？', '--repo', repo, '--data-dir', dataDir);
    expect(r.code).toBe(0);
    expect(r.out).toBe('先查一下。\n\n退款由 refund 处理。\n');
    expect(r.err).toContain('[tool] search_symbols query="refund"');
    expect(r.err).toContain('[tool] get_symbol failed: not_found');
    expect(r.err).toContain('via the local claude-code CLI');
  });

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('%s ends the claude process and exits', async (sig) => {
    const child = spawnCli(['ask', '退款流程怎么走？', '--repo', repo, '--data-dir', dataDir], scenario('stream-then-hang'));
    let out = '';
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    const code = exited(child);
    await waitFor(() => out.length > 0 && records().length > 0);
    const pid = records()[0]!.pid;
    expect(alive(pid)).toBe(true);
    child.kill(sig);
    expect(await code).toBe(128 + constants.signals[sig]);
    expect(out).toContain('已经收到的部分');
    await waitFor(() => !alive(pid), 5_000);
  });
});

describe('codeinsight overview with a local CLI', () => {
  it('generates the AI descriptions with the fake claude', async () => {
    Object.assign(process.env, scenario('overview'));
    const r = await cli('overview', '--repo', repo, '--data-dir', tempDir('ci-cli-ov-data-'), '--yes', '--format', 'json');
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as { system?: { title: string }; modules: { name: string }[] };
    expect(report.system?.title).toBe('系统');
    expect(report.modules.some((m) => m.name === '模块')).toBe(true);
    expect(records().length).toBeGreaterThan(0);
  });

  it('SIGINT ends the claude processes, exits with 130 and does not save the overview', async () => {
    const ovData = tempDir('ci-cli-ov-sig-');
    const child = spawnCli(['overview', '--repo', repo, '--data-dir', ovData, '--yes', '--format', 'json'], scenario('hang'));
    let out = '';
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    const code = exited(child);
    await waitFor(() => records().length > 0, 60_000);
    expect(alive(records()[0]!.pid)).toBe(true);
    child.kill('SIGINT');
    expect(await code).toBe(130);
    for (const { pid } of records()) await waitFor(() => !alive(pid), 5_000);
    expect(out).toBe('');
    const store = new Store(dataDirLayout(ovData).dbPath);
    try {
      const rows = store.overviews.list();
      expect(rows.map((r) => r.status)).toEqual(['failed']);
      expect(rows[0]!.error).toContain('cancelled');
    } finally {
      store.close();
    }
  });
});

describe('codeinsight mcp --ask-tools', () => {
  it('exits 1 with one stderr line when the snapshot does not exist', async () => {
    const r = await cli('mcp', '--ask-tools', '--repo', repo, '--data-dir', dataDir, '--snapshot', '999999');
    expect(r.code).toBe(1);
    expect(r.err).toBe('error: snapshot 999999 does not exist\n');
  });

  it('mcp --help notes that --ask-tools is internal', async () => {
    expect((await cli('mcp', '--help')).out).toBe(MCP_USAGE);
    expect(MCP_USAGE).toMatch(/--ask-tools is used internally by ask\.\n$/);
    expect((await cli('--help')).out).not.toContain('ask-tools');
  });
});

describe('codeinsight serve shutdown', () => {
  it('SIGTERM ends a running claude process and saves the answer as cancelled', async () => {
    const serveData = tempDir('ci-cli-serve-cli-');
    const child = spawnCli(['serve', '--repo', repo, '--data-dir', serveData], scenario('stream-then-hang'));
    let out = '';
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    const code = exited(child);
    await waitFor(() => out.includes('\n'));
    const { port, token } = JSON.parse(out.split('\n')[0]!) as { port: number; token: string };
    const api = (p: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${p}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    await waitFor(async () => ((await (await api('/api/status')).json()) as { index: { job: { status: string } | null } }).index.job?.status === 'done', 60_000);
    const { id } = (await (await api('/api/chat/sessions', { method: 'POST', body: '{}' })).json()) as { id: number };
    void api(`/api/chat/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ question: '退款流程怎么走？' }) }).then((r) => r.text()).catch(() => undefined);
    await waitFor(() => records().length > 0);
    const pid = records()[0]!.pid;
    child.kill('SIGTERM');
    expect(await code).toBe(0);
    expect(alive(pid)).toBe(false);
    const store = new Store(dataDirLayout(serveData).dbPath);
    try {
      expect(store.chats.messages(id).at(-1)?.meta?.status).toBe('cancelled');
    } finally {
      store.close();
    }
  });
});
