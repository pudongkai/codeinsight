import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  askJson, buildSnapshot, ClaudeCodeClient, claudeArgs, CliError, createLlmClient, flattenMessages, flushOpencodeSessions, initDataDir,
  INTENT_JSON_SCHEMA, isCliClient, jsonRetryPrompt, killActiveCliProcesses, llmClientFromConfig, llmIdentity, LlmTruncatedError, loadConfig,
  OPENCODE_PERMISSIONS_VERIFIED, OpencodeClient, opencodeArgs, OVERVIEW_JSON_SCHEMAS, parseJsonReply, resetCliShutdown, resolveCliCommand, runCli, runIntentCheck,
  runOverview, setLogSink, Store, withCliTempDir, type CliClientOptions, type CliSpec, type LlmRequest,
} from '../src/index.js';
import { commitAll, git, tempDir } from './helpers/git-repo.js';

const FAKE_CLAUDE = path.join(import.meta.dirname, 'helpers', 'fake-claude.mjs');
const FAKE_OPENCODE = path.join(import.meta.dirname, 'helpers', 'fake-opencode.mjs');
const posix = process.platform !== 'win32';

interface Record_ {
  argv: string[];
  stdin: string;
  cwd: string;
  pwd?: string;
  envNames: string[];
  env: Record<string, string>;
  system?: { mode: string; content: string };
  scenario?: string;
  sessionDelete?: string;
  grandchildPid?: number;
}

let recordFile = '';
function records(): Record_[] {
  if (!existsSync(recordFile)) return [];
  return readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record_);
}

/** 设定假 CLI 的场景并换一个新的记录文件 */
function scenario(name: string, env: Record<string, string> = {}): void {
  recordFile = path.join(tempDir('ci-cli-rec-'), 'record.jsonl');
  process.env.FAKE_CLI_SCENARIO = name;
  process.env.FAKE_CLI_RECORD = recordFile;
  for (const k of ['FAKE_CLI_JSON', 'FAKE_CLI_TEXT', 'FAKE_OPENCODE_DELETE_FAIL', 'FAKE_CLI_RECORD_ENV']) delete process.env[k];
  Object.assign(process.env, env);
}

const claude = (o: Partial<CliClientOptions> = {}) => new ClaudeCodeClient({ command: FAKE_CLAUDE, model: '', timeoutMs: 20_000, ...o });
const opencode = (o: Partial<CliClientOptions> = {}) => new OpencodeClient({ command: FAKE_OPENCODE, model: '', timeoutMs: 20_000, ...o });
const REQ: LlmRequest = { system: 'SYSTEM-TEXT', messages: [{ role: 'user', content: 'PROMPT-SECRET-123' }], maxTokens: 300 };

async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const prev = setLogSink((l) => lines.push(l));
  try {
    return { result: await fn(), lines };
  } finally {
    setLogSink(prev);
  }
}

async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a failure');
}

async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
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

let claudeConfigDir = '';
beforeAll(() => {
  chmodSync(FAKE_CLAUDE, 0o755);
  chmodSync(FAKE_OPENCODE, 0o755);
  // 不读本机真实的 Claude Code 设置
  claudeConfigDir = tempDir('ci-claude-cfg-');
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  process.env.XDG_CONFIG_HOME = tempDir('ci-xdg-');
});
beforeEach(() => resetCliShutdown());
afterAll(async () => {
  await flushOpencodeSessions(5_000);
  await killActiveCliProcesses();
});

describe.skipIf(!posix)('resolveCliCommand', () => {
  const exe = (dir: string, name: string, mode = 0o755) => {
    mkdirSync(dir, { recursive: true });
    const f = path.join(dir, name);
    writeFileSync(f, '#!/bin/sh\n');
    chmodSync(f, mode);
    return f;
  };

  it('finds the command in PATH', () => {
    const dir = tempDir();
    const f = exe(dir, 'claude');
    expect(resolveCliCommand('claude-code', undefined, { PATH: `/nonexistent:${dir}` }, { home: tempDir(), noCache: true })).toEqual({ ok: true, path: f });
  });

  it('falls back to common install directories when PATH has no match', () => {
    const home = tempDir();
    const f = exe(path.join(home, '.local', 'bin'), 'opencode');
    expect(resolveCliCommand('opencode', undefined, { PATH: '' }, { home, noCache: true })).toEqual({ ok: true, path: f });
  });

  it('reports command_not_found and not_executable for absolute paths', () => {
    const r = resolveCliCommand('claude-code', '/nonexistent/claude', {}, { noCache: true });
    expect(!r.ok && r.error.kind).toBe('command_not_found');
    expect(!r.ok && r.error.message).toContain('CODEINSIGHT_LLM_COMMAND');
    const f = exe(tempDir(), 'claude', 0o644);
    const r2 = resolveCliCommand('claude-code', f, {}, { noCache: true });
    expect(!r2.ok && r2.error.kind).toBe('not_executable');
  });

  it('reports command_not_found for unknown names and relative paths', () => {
    const r = resolveCliCommand('claude-code', 'no-such-cli-xyz', { PATH: tempDir() }, { home: tempDir(), noCache: true });
    expect(!r.ok && r.error.kind).toBe('command_not_found');
    const r2 = resolveCliCommand('claude-code', 'bin/claude', { PATH: tempDir() }, { home: tempDir(), noCache: true });
    expect(!r2.ok && r2.error.kind).toBe('command_not_found');
  });

  it('only accepts .exe on Windows and reports a .cmd shim as not_executable', () => {
    const dir = tempDir();
    exe(dir, 'claude.cmd');
    const r = resolveCliCommand('claude-code', undefined, { PATH: dir }, { platform: 'win32', home: tempDir(), noCache: true });
    expect(!r.ok && r.error.kind).toBe('not_executable');
    expect(!r.ok && r.error.message).toContain('.exe');
    const f = exe(dir, 'claude.exe');
    expect(resolveCliCommand('claude-code', undefined, { PATH: dir }, { platform: 'win32', home: tempDir(), noCache: true })).toEqual({ ok: true, path: f });
  });
});

describe('CLI arguments', () => {
  it('builds the full Claude Code argument lists for a structured call and an ask call', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    expect(claudeArgs({ mode: 'complete', systemFile: '/t/system.md', jsonSchema: schema, model: 'sonnet' })).toEqual([
      '-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--permission-mode', 'dontAsk',
      '--no-session-persistence', '--disable-slash-commands', '--system-prompt-file', '/t/system.md', '--json-schema', JSON.stringify(schema),
      '--max-turns', '3', '--model=sonnet',
    ]);
    expect(claudeArgs({ mode: 'ask', systemFile: '/t/system.md', mcpConfigFile: '/t/mcp.json', allowedTools: ['mcp__codeinsight__a', 'mcp__codeinsight__b'], maxTurns: 13 })).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--tools', '', '--strict-mcp-config', '--setting-sources', '',
      '--permission-mode', 'dontAsk', '--no-session-persistence', '--disable-slash-commands', '--mcp-config', '/t/mcp.json',
      '--allowedTools', 'mcp__codeinsight__a,mcp__codeinsight__b', '--max-turns', '13', '--system-prompt-file', '/t/system.md',
    ]);
    expect(opencodeArgs('zbyte/qwen')).toEqual(['run', '--standalone', '--format', 'json', '--agent', 'codeinsight', '--title', 'codeinsight', '--model=zbyte/qwen']);
  });
});

describe.skipIf(!posix)('Claude Code client with a fake claude', () => {
  beforeEach(() => {
    writeFileSync(path.join(claudeConfigDir, 'settings.json'), '{}');
  });

  it('sends the prompt on stdin only, runs in a private temp dir, and returns the structured output', async () => {
    scenario('ok-structured', { FAKE_CLI_JSON: '{"answer":"yes"}', FAKE_CLI_RECORD_ENV: 'CLAUDE_CODE_MAX_OUTPUT_TOKENS,CLAUDE_CODE_DISABLE_CLAUDE_MDS' });
    const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
    const text = await claude({ model: 'sonnet' }).complete({ ...REQ, jsonSchema: schema });
    expect(JSON.parse(text)).toEqual({ answer: 'yes' });
    const [r] = records();
    expect(r!.stdin).toBe('PROMPT-SECRET-123');
    expect(r!.argv.join(' ')).not.toContain('PROMPT-SECRET-123');
    expect(r!.argv.join(' ')).not.toContain('SYSTEM-TEXT');
    expect(r!.argv).toContain('--model=sonnet');
    expect(r!.argv[r!.argv.indexOf('--json-schema') + 1]).toBe(JSON.stringify(schema));
    expect(r!.system).toEqual({ mode: '600', content: 'SYSTEM-TEXT' });
    expect(r!.pwd).toBe(r!.cwd);
    expect(path.basename(r!.cwd)).toMatch(/^codeinsight-cli-/);
    expect(existsSync(r!.cwd)).toBe(false);
    expect(r!.env).toEqual({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: '300', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' });
  });

  it('returns plain text when there is no schema and leaves --json-schema and --model out', async () => {
    scenario('ok-text', { FAKE_CLI_TEXT: 'plain reply' });
    expect(await claude().complete(REQ)).toBe('plain reply');
    expect(records()[0]!.argv).not.toContain('--json-schema');
    expect(records()[0]!.argv.some((a) => a.startsWith('--model'))).toBe(false);
  });

  it('strips API keys, merges the env of the Claude Code settings file, and lets extra env override it', async () => {
    writeFileSync(path.join(claudeConfigDir, 'settings.json'), JSON.stringify({ env: { https_proxy: 'http://proxy:1', ANTHROPIC_BASE_URL: 'http://gw', NUM: 3 }, apiKeyHelper: 'x' }));
    scenario('ok-text', { FAKE_CLI_RECORD_ENV: 'https_proxy,ANTHROPIC_BASE_URL,MY_EXTRA,ANTHROPIC_API_KEY,OPENAI_API_KEY,NUM' });
    const baseEnv = { ...process.env, ANTHROPIC_API_KEY: 'sk-parent', OPENAI_API_KEY: 'sk-openai' };
    const { lines } = await captureLogs(() => claude({ baseEnv, extraEnv: { MY_EXTRA: 'extra-value', https_proxy: 'http://override:2' } }).complete(REQ));
    expect(records()[0]!.env).toEqual({ https_proxy: 'http://override:2', ANTHROPIC_BASE_URL: 'http://gw', MY_EXTRA: 'extra-value' });
    const start = lines.find((l) => l.includes('llm_cli_start'))!;
    expect(start).toContain('MY_EXTRA');
    expect(start).not.toContain('extra-value');
    expect(start).not.toContain('PROMPT-SECRET-123');
    expect(start).not.toContain('http://gw');
  });

  it('skips a corrupt Claude Code settings file', async () => {
    writeFileSync(path.join(claudeConfigDir, 'settings.json'), '{not json');
    scenario('ok-text');
    const { lines } = await captureLogs(() => claude().complete(REQ));
    expect(lines.some((l) => l.includes('llm_cli_claude_settings_invalid'))).toBe(true);
  });

  it('flattens the askJson retry into one stdin message with the previous reply and the feedback', async () => {
    scenario('ok-text,ok-structured', { FAKE_CLI_TEXT: 'not json at all', FAKE_CLI_JSON: '{"answer":"ok"}' });
    const r = await askJson({
      client: claude(), system: 's', prompt: 'ORIGINAL', maxTokens: 100, items: 1, retryPrompt: jsonRetryPrompt,
      parse: (reply) => parseJsonReply(reply), jsonSchema: { type: 'object' },
    });
    expect(r).toEqual({ ok: true, value: { answer: 'ok' } });
    const second = records()[1]!.stdin;
    expect(second).toBe(flattenMessages([
      { role: 'user', content: 'ORIGINAL' }, { role: 'assistant', content: 'not json at all' }, { role: 'user', content: jsonRetryPrompt('reply is not valid JSON') },
    ]));
    expect(second).toContain('Your previous reply:\nnot json at all');
    expect(records()[1]!.argv).toContain('--json-schema');
  });

  it.each([
    ['not-logged-in', 'not_logged_in', 401],
    ['billing', 'quota', 402],
    ['overloaded', 'server_error', 503],
    ['max-turns', 'cli_failed', undefined],
    ['schema-retries', 'bad_response', undefined],
    ['bad-json', 'bad_response', undefined],
  ])('classifies %s as %s', async (name, kind, status) => {
    scenario(name);
    const err = await failure(claude().complete(REQ));
    expect(err).toBeInstanceOf(CliError);
    expect(err).toMatchObject({ kind, status });
  });

  it('tells how to log in when not logged in', async () => {
    scenario('not-logged-in');
    expect((await failure(claude().complete(REQ))).message).toContain('run `claude` in a terminal to log in');
  });

  it('reports cli_failed with the first stderr line for bad arguments', async () => {
    scenario('exit-2-stderr');
    const err = await failure(claude().complete(REQ));
    expect(err).toMatchObject({ kind: 'cli_failed' });
    expect(err.message).toContain('requires --verbose');
  });

  it('reports command_not_found when spawn fails with ENOENT', async () => {
    scenario('ok-text');
    expect(await failure(claude({ command: '/nonexistent/claude' }).complete(REQ))).toMatchObject({ kind: 'command_not_found' });
  });

  it('throws LlmTruncatedError when the reply hit the output limit', async () => {
    scenario('truncated');
    const err = await failure(claude().complete(REQ));
    expect(err).toBeInstanceOf(LlmTruncatedError);
    expect((err as LlmTruncatedError).maxTokens).toBe(300);
  });

  it('lets askJson wait and retry after a rate limit', async () => {
    scenario('rate-limit,ok-structured');
    const r = await askJson({ client: claude(), system: 's', prompt: 'p', maxTokens: 100, items: 1, retryPrompt: jsonRetryPrompt, parse: parseJsonReply, transientRetries: 1 });
    expect(r.ok).toBe(true);
    expect(records().map((x) => x.scenario)).toEqual(['rate-limit', 'ok-structured']);
  }, 15_000);

  it('does not retry when not logged in', async () => {
    scenario('not-logged-in,ok-structured');
    const r = await askJson({ client: claude(), system: 's', prompt: 'p', maxTokens: 100, items: 1, retryPrompt: jsonRetryPrompt, parse: parseJsonReply, transientRetries: 2 });
    expect(r).toMatchObject({ ok: false, failure: 'request' });
    expect(records()).toHaveLength(1);
  });
});

describe.skipIf(!posix)('timeouts and cancellation', () => {
  const spec = (dir: string): CliSpec => ({ provider: 'claude-code', command: FAKE_CLAUDE, args: ['-p'], env: {}, stdin: 'x', cwd: dir, mode: 'complete' });

  it('ends a hanging CLI after timeoutMs and reports timeout', async () => {
    scenario('hang');
    const started = Date.now();
    const err = await failure(claude({ timeoutMs: 600 }).complete(REQ));
    expect(err).toMatchObject({ kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('ends the CLI when output stops for longer than idleTimeoutMs', async () => {
    scenario('slow-then-hang');
    const exit = await withCliTempDir((dir) => runCli(spec(dir), { timeoutMs: 20_000, idleTimeoutMs: 400 }));
    expect(exit.timedOut).toBe(true);
    expect(exit.ms).toBeLessThan(5_000);
  });

  it('ends the whole process group on abort, including grandchildren', async () => {
    scenario('spawn-grandchild');
    const ctl = new AbortController();
    const started = Date.now();
    const run = withCliTempDir((dir) => runCli(spec(dir), { timeoutMs: 20_000, signal: ctl.signal }));
    await waitFor(() => records().some((r) => r.grandchildPid));
    const pid = records().find((r) => r.grandchildPid)!.grandchildPid!;
    expect(alive(pid)).toBe(true);
    ctl.abort();
    const exit = await run;
    expect(exit.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(8_000);
    await waitFor(() => !alive(pid), 3_000);
  });

  it('killActiveCliProcesses ends every running CLI', async () => {
    scenario('hang');
    const runs = [1, 2].map(() => withCliTempDir((dir) => runCli(spec(dir), { timeoutMs: 20_000 })));
    await waitFor(() => records().length === 2);
    expect(await killActiveCliProcesses()).toBe(2);
    const exits = await Promise.all(runs);
    expect(exits.every((e) => e.exitCode !== 0)).toBe(true);
    expect(await killActiveCliProcesses()).toBe(0);
  });

  it('does not start the CLI when aborted while the environment is being prepared', async () => {
    scenario('ok-text');
    const ctl = new AbortController();
    const run = withCliTempDir((dir) => runCli(spec(dir), { timeoutMs: 20_000, signal: ctl.signal }));
    ctl.abort();
    expect((await run).aborted).toBe(true);
    expect(records()).toHaveLength(0);
  });

  it('starts no new CLI after killActiveCliProcesses until reset, including one already being prepared', async () => {
    scenario('ok-text');
    const pending = withCliTempDir((dir) => runCli(spec(dir), { timeoutMs: 20_000 }));
    await killActiveCliProcesses();
    expect((await pending).aborted).toBe(true);
    expect(await failure(claude().complete(REQ))).toMatchObject({ kind: 'cancelled' });
    expect(records()).toHaveLength(0);
    resetCliShutdown();
    expect(await claude().complete(REQ)).toBe('OK');
    expect(records()).toHaveLength(1);
  });
});

describe.skipIf(!posix)('opencode client with a fake opencode', () => {
  it('runs the codeinsight agent with a deny-all config, disables global MCP servers and deletes the session afterwards', async () => {
    const xdg = tempDir('ci-xdg-');
    mkdirSync(path.join(xdg, 'opencode'));
    writeFileSync(path.join(xdg, 'opencode', 'opencode.jsonc'), '{\n // comment\n "mcp": {"servers": {"codegraph": {"type": "local", "command": ["x"]}}, "legacy": {"type": "local", "command": ["y"]},},\n}');
    scenario('ok-text', { FAKE_CLI_TEXT: 'hi there', FAKE_CLI_RECORD_ENV: 'OPENCODE_CONFIG_CONTENT,OPENCODE_DISABLE_PROJECT_CONFIG,OPENCODE_DISABLE_CLAUDE_CODE' });
    const text = await opencode({ model: 'p/m', baseEnv: { ...process.env, XDG_CONFIG_HOME: xdg } }).complete(REQ);
    expect(text).toBe('hi there');
    const [run] = records();
    expect(run!.stdin).toBe('PROMPT-SECRET-123');
    expect(run!.argv).toEqual(['run', '--standalone', '--format', 'json', '--agent', 'codeinsight', '--title', 'codeinsight', '--model=p/m']);
    expect(run!.pwd).toBe(run!.cwd);
    const config = JSON.parse(run!.env.OPENCODE_CONFIG_CONTENT!) as { permission: unknown; agent: { codeinsight: { prompt: string } }; mcp: unknown };
    expect(config.permission).toEqual({ '*': 'deny' });
    expect(config.agent.codeinsight).toMatchObject({ mode: 'primary', steps: 3, permission: { '*': 'deny' } });
    expect(config.agent.codeinsight.prompt).toBe(`{file:${path.join(run!.cwd, 'system.md')}}`);
    expect(config.mcp).toEqual({
      codegraph: { type: 'local', command: ['false'], enabled: false },
      legacy: { type: 'local', command: ['false'], enabled: false },
    });
    expect(run!.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    expect(run!.env.OPENCODE_DISABLE_CLAUDE_CODE).toBe('1');
    expect(await flushOpencodeSessions(5_000)).toBe(0);
    expect(records().map((r) => r.sessionDelete).filter(Boolean)).toEqual(['ses_fake123']);
  });

  it('still deletes the session when the run failed or timed out, and only logs a failed delete', async () => {
    scenario('auth-error', { FAKE_OPENCODE_DELETE_FAIL: '1' });
    expect(await failure(opencode().complete(REQ))).toMatchObject({ kind: 'not_logged_in', status: 401 });
    const { lines } = await captureLogs(() => flushOpencodeSessions(5_000));
    expect(lines.some((l) => l.includes('llm_cli_session_delete_failed'))).toBe(true);
    scenario('hang');
    expect(await failure(opencode({ timeoutMs: 800 }).complete(REQ))).toMatchObject({ kind: 'timeout' });
    await flushOpencodeSessions(5_000);
    expect(records().map((r) => r.sessionDelete).filter(Boolean)).toEqual(['ses_fake123']);
  });

  it.each([
    ['rate-limit-v1', 'rate_limited', 429],
    ['free-limit', 'quota', 402],
    ['context-overflow', 'context_overflow', undefined],
    ['no-session-exit', 'cli_failed', undefined],
  ])('classifies %s as %s', async (name, kind, status) => {
    scenario(name);
    expect(await failure(opencode().complete(REQ))).toMatchObject({ kind, status });
    await flushOpencodeSessions(5_000);
  });

  it('skips the session delete when no session id was printed', async () => {
    scenario('no-session-exit');
    await failure(opencode().complete(REQ));
    await flushOpencodeSessions(5_000);
    expect(records().filter((r) => r.sessionDelete)).toHaveLength(0);
  });

  it('throws LlmTruncatedError when the step ended for length', async () => {
    scenario('truncated');
    expect(await failure(opencode().complete(REQ))).toBeInstanceOf(LlmTruncatedError);
    await flushOpencodeSessions(5_000);
  });
});

describe('creating CLI clients', () => {
  it('creates a Claude Code client for an executable command and reports a missing one as llm_not_configured', () => {
    const client = createLlmClient({ provider: 'claude-code', model: '', command: FAKE_CLAUDE });
    expect(isCliClient(client)).toBe(true);
    expect(client).toMatchObject({ provider: 'claude-code', model: '', baseUrl: undefined });
    const r = llmClientFromConfig({ llm: { provider: 'claude-code', model: '', command: '/nonexistent/claude' } }, { skipped: 'AI descriptions skipped' });
    expect(r).toMatchObject({ warning: { code: 'llm_not_configured' } });
    expect(r && 'warning' in r && r.warning.message).toContain('command not found');
  });

  it('keeps opencode unavailable until its permission isolation is verified', () => {
    expect(OPENCODE_PERMISSIONS_VERIFIED).toBe(false);
    const err = (() => {
      try {
        createLlmClient({ provider: 'opencode', model: '', command: FAKE_OPENCODE });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toMatchObject({ kind: 'provider_unavailable' });
  });

  it('uses "default" for an empty CLI model in the cache identity', () => {
    const empty = llmIdentity({ provider: 'claude-code', model: '' });
    expect(empty).toBe(llmIdentity({ provider: 'claude-code', model: 'default' }));
    expect(empty).not.toBe(llmIdentity({ provider: 'claude-code', model: 'sonnet' }));
    expect(empty).not.toBe(llmIdentity({ provider: 'anthropic', model: '', baseUrl: 'https://api.anthropic.com' }));
    expect(llmIdentity({ provider: 'opencode', model: '' })).not.toBe(empty);
  });

  it('counts ANTHROPIC_MODEL from the merged environment in the identity when no model is set', () => {
    writeFileSync(path.join(claudeConfigDir, 'settings.json'), '{}');
    const id = (cfg: { model?: string; extraEnv?: Record<string, string> }) =>
      llmIdentity(createLlmClient({ provider: 'claude-code', model: cfg.model ?? '', command: FAKE_CLAUDE, extraEnv: cfg.extraEnv }));
    const plain = id({});
    expect(plain).toBe(llmIdentity({ provider: 'claude-code', model: '' }));
    const fromExtra = id({ extraEnv: { ANTHROPIC_MODEL: 'opus' } });
    expect(fromExtra).not.toBe(plain);
    writeFileSync(path.join(claudeConfigDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'haiku' } }));
    const fromSettings = id({});
    expect(fromSettings).not.toBe(plain);
    expect(fromSettings).not.toBe(fromExtra);
    expect(id({ extraEnv: { ANTHROPIC_MODEL: 'opus' } })).toBe(fromExtra);
    expect(id({ model: 'sonnet', extraEnv: { ANTHROPIC_MODEL: 'opus' } })).toBe(llmIdentity({ provider: 'claude-code', model: 'sonnet' }));
    writeFileSync(path.join(claudeConfigDir, 'settings.json'), '{}');
  });

  it('leaves the JSON schema out of API request bodies', async () => {
    const bodies: Record<string, unknown>[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ content: [{ type: 'text', text: '{}' }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await createLlmClient({ provider: 'anthropic', model: 'm', apiKey: 'k', baseUrl }).complete({ ...REQ, jsonSchema: { type: 'object' } });
      expect(Object.keys(bodies[0]!).sort()).toEqual(['max_tokens', 'messages', 'model', 'system']);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe.skipIf(!posix)('overview and intent check through a fake Claude Code', () => {
  it('runs the intent check with the intent JSON schema', async () => {
    const reply = { groups: [{ verdict: 'mentioned', summary: 'Login', symbols: ['pkg/a.py#function#login#'] }] };
    scenario('ok-structured', { FAKE_CLI_JSON: JSON.stringify(reply) });
    const key = 'pkg/a.py#function#login#';
    const r = await runIntentCheck({
      intentText: 'Fix login', addedFiles: [], cacheDir: tempDir('ci-llm-cache-'), client: claude(),
      items: [{ key, module: 'pkg', change: 'modified', displaySignature: '(user)', docLine: null }],
      refs: new Map([[key, { key, id: key, kind: 'function', name: 'login', qualifiedName: 'login', path: 'pkg/a.py', startLine: 1, isTest: false }]]),
    });
    expect(r.findings).toHaveLength(1);
    const argv = records()[0]!.argv;
    expect(JSON.parse(argv[argv.indexOf('--json-schema') + 1]!)).toEqual(INTENT_JSON_SCHEMA);
  });

  it('generates the overview AI descriptions with a schema per request kind', async () => {
    const repo = tempDir('ci-cli-shop-');
    cpSync(path.join(import.meta.dirname, 'fixtures', 'py-shop'), repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    commitAll(repo, 'init');
    writeFileSync(path.join(repo, 'codeinsight.config.json'), JSON.stringify({ overview: { moduleMinSize: 3, moduleMaxSize: 15, leafSplitSize: 8 } }));
    scenario('overview');
    const config = await loadConfig(repo, { dataDir: tempDir('ci-cli-data-'), env: { CODEINSIGHT_LLM_PROVIDER: 'claude-code', CODEINSIGHT_LLM_COMMAND: FAKE_CLAUDE } });
    expect(config.overview.concurrency).toBe(2);
    const layout = await initDataDir(config.dataDir);
    const store = new Store(layout.dbPath);
    try {
      const { snapshot } = await buildSnapshot({ repo, store, layout, config });
      const { report } = await runOverview({ repo, store, layout, config, snapshot, ref: 'working' });
      expect(report.ai.calls).toBeGreaterThan(0);
      expect(report.ai.failed).toBe(0);
      expect(report.modules.every((m) => m.aiStatus === 'ok')).toBe(true);
      const sent = records();
      expect(sent).toHaveLength(report.ai.calls);
      for (const r of sent) {
        const task = /"task":"(\w+)"/.exec(r.stdin)![1]!;
        const kind = task === 'module_summary' ? 'module' : task === 'feature_naming' ? 'features' : task === 'group_summary' ? 'system_group' : 'system';
        expect(JSON.parse(r.argv[r.argv.indexOf('--json-schema') + 1]!)).toEqual(OVERVIEW_JSON_SCHEMAS[kind]);
      }
    } finally {
      store.close();
    }
  }, 60_000);
});
