import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setLogSink, userSettingsPath } from '@codeinsight/core';
import { startHttpServer, type HttpServerOptions, type RunningHttpServer } from '../src/index.js';
import { apiFor, openWorkspace, shopRepo, tempDir, waitFor, type Api } from './helpers/env.js';

/** 本机 CLI 的设置接口、测试连接和 status；CLI 用 core 的假 claude */

const FAKE_CLAUDE = path.resolve(import.meta.dirname, '..', '..', 'core', 'test', 'helpers', 'fake-claude.mjs');
const TOKEN_VALUE = 'tok-SECRET-value-42';
const PROXY_PASSWORD = 'pw-SECRET-77';

interface SettingsView {
  llm: {
    provider: { value: string | null; source: string };
    model: { value: string | null; source: string };
    baseUrl: { value: string | null; source: string };
    apiKey: { set: boolean; source: string };
    command: { value: string | null; source: string; env?: string; resolved: string | null };
    extraEnv: { source: string; entries: { name: string; value?: string; set?: true }[] };
  };
  effective: { configured: boolean; kind: string | null; provider: string | null; model: string | null; problem: string | null };
  unavailableProviders: string[];
}
interface Status { llmConfigured: boolean; llm: Record<string, unknown> | null; llmProblem: string | null }
interface TestResult { ok: boolean; reason?: string; message?: string; provider?: string; model?: string; command?: string; version?: string }

const logLines: string[] = [];
const bodies: string[] = [];
const servers: RunningHttpServer[] = [];
let restoreSink: ((line: string) => void) | undefined;
const prevLevel = process.env.CODEINSIGHT_LOG;

/** 假 CLI 的环境：PATH（找 node）、空的 Claude Code 配置目录、调用记录文件；场景按用例改 */
function cliEnv(): Record<string, string> {
  const dir = tempDir('ci-cli-env-');
  return { PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: dir, FAKE_CLI_RECORD: path.join(dir, 'record.jsonl'), FAKE_CLI_SCENARIO: 'ok-text' };
}

async function startServer(opts: HttpServerOptions): Promise<RunningHttpServer> {
  const server = await startHttpServer({ indexOnStart: false, dirPicker: { tool: null }, ...opts });
  servers.push(server);
  return server;
}

async function start(opts: HttpServerOptions): Promise<Api> {
  const api = apiFor(await startServer(opts));
  return async (p, o) => {
    const r = await api(p, o);
    bodies.push(JSON.stringify(r.body));
    return r;
  };
}

const post = <T>(api: Api, p: string, body: Record<string, unknown>) => api<T>(p, { method: 'POST', body });
const saveLlm = (api: Api, body: Record<string, unknown>) => post<SettingsView & { error?: string; message?: string }>(api, '/api/settings/llm', body);
const testLlm = (api: Api, body: Record<string, unknown>) => post<TestResult & { error?: string }>(api, '/api/settings/llm/test', body);
const userSettings = () => JSON.parse(readFileSync(userSettingsPath(), 'utf8')) as { llm?: Record<string, unknown> };
const records = (env: Record<string, string>) => (existsSync(env.FAKE_CLI_RECORD!) ? readFileSync(env.FAKE_CLI_RECORD!, 'utf8').split('\n').filter(Boolean) : []);

beforeAll(() => {
  process.env.CODEINSIGHT_LOG = 'debug';
  restoreSink = setLogSink((line) => logLines.push(line));
  chmodSync(FAKE_CLAUDE, 0o755);
});

afterAll(async () => {
  for (const s of servers) await s.close();
  if (restoreSink) setLogSink(restoreSink);
  if (prevLevel === undefined) delete process.env.CODEINSIGHT_LOG;
  else process.env.CODEINSIGHT_LOG = prevLevel;
});

describe('saving a CLI provider', () => {
  const env = cliEnv();
  let api: Api;
  beforeAll(async () => {
    api = await start({ env });
  });

  it('drops the saved key and service address, hides secret values and keeps hidden values on the next save', async () => {
    expect((await saveLlm(api, { provider: 'openai-compatible', baseUrl: 'https://llm.example.com/v1', model: 'gpt-x', apiKey: 'sk-SECRET-api-key-123456' })).status).toBe(200);
    const extraEnv = [{ name: 'https_proxy', value: `http://me:${PROXY_PASSWORD}@proxy.local:3128` }, { name: 'MY_TOKEN', value: TOKEN_VALUE }];
    const r = await saveLlm(api, { provider: 'claude-code', command: FAKE_CLAUDE, extraEnv });
    expect(r.status).toBe(200);
    expect(userSettings().llm).toEqual({ provider: 'claude-code', command: FAKE_CLAUDE, extraEnv: { https_proxy: `http://me:${PROXY_PASSWORD}@proxy.local:3128`, MY_TOKEN: TOKEN_VALUE } });
    expect(r.body.llm.command).toEqual({ value: FAKE_CLAUDE, source: 'user', resolved: FAKE_CLAUDE });
    expect(r.body.llm.extraEnv).toEqual({ source: 'user', entries: [{ name: 'https_proxy', value: 'http://proxy.local:3128', masked: true }, { name: 'MY_TOKEN', set: true }] });
    expect(r.body.llm.apiKey).toMatchObject({ set: false, source: 'none' });
    expect(r.body.effective).toEqual({ configured: true, kind: 'cli', provider: 'claude-code', model: '', problem: null });

    const again = await saveLlm(api, { provider: 'claude-code', command: FAKE_CLAUDE, extraEnv: [{ name: 'MY_TOKEN' }, { name: 'NO_PROXY', value: 'localhost' }] });
    expect(again.status).toBe(200);
    expect(userSettings().llm?.extraEnv).toEqual({ MY_TOKEN: TOKEN_VALUE, NO_PROXY: 'localhost' });
  });

  it('returns values only for proxy and *_BASE_URL variables, without credentials, query or fragment', async () => {
    const extraEnv = [
      { name: 'ANTHROPIC_CUSTOM_HEADERS', value: 'Authorization: Bearer hdr-SECRET' },
      { name: 'ANTHROPIC_BASE_URL', value: 'https://u:base-SECRET@gw.example.com/v1?token=q-SECRET#frag-SECRET' },
      { name: 'HTTP_PROXY', value: 'user:noproto-SECRET@proxy:3128' },
      { name: 'HTTPS_PROXY', value: 'http://u:p@ss-SECRET@proxy.local:3128' },
      { name: 'all_proxy', value: 'socks5://10.0.0.1:1080' },
      { name: 'NO_PROXY', value: 'localhost,127.0.0.1' },
      { name: 'FOO', value: 'plain-SECRET' },
    ];
    const r = await saveLlm(api, { provider: 'claude-code', command: FAKE_CLAUDE, extraEnv });
    expect(r.body.llm.extraEnv.entries).toEqual([
      { name: 'ANTHROPIC_CUSTOM_HEADERS', set: true },
      { name: 'ANTHROPIC_BASE_URL', value: 'https://gw.example.com/v1', masked: true },
      { name: 'HTTP_PROXY', set: true },
      { name: 'HTTPS_PROXY', value: 'http://proxy.local:3128', masked: true },
      { name: 'all_proxy', value: 'socks5://10.0.0.1:1080' },
      { name: 'NO_PROXY', value: 'localhost,127.0.0.1' },
      { name: 'FOO', set: true },
    ]);
    expect(JSON.stringify(r.body)).not.toContain('SECRET');
    // 恢复前一个用例保存的内容，后面的用例接着用
    await saveLlm(api, { provider: 'claude-code', command: FAKE_CLAUDE, extraEnv: [{ name: 'MY_TOKEN', value: TOKEN_VALUE }, { name: 'NO_PROXY', value: 'localhost' }] });
  });

  it('rejects keys, service addresses, relative commands and bad extra variables', async () => {
    const before = readFileSync(userSettingsPath(), 'utf8');
    const bad: [Record<string, unknown>, string][] = [
      [{ apiKey: 'sk-x' }, 'apiKey'],
      [{ baseUrl: 'https://x.example' }, 'baseUrl'],
      [{ command: 'bin/claude' }, 'command'],
      [{ extraEnv: [{ name: 'GONE' }] }, 'GONE'],
      [{ extraEnv: [{ name: 'A', value: '1' }, { name: 'A', value: '2' }] }, 'more than once'],
      [{ extraEnv: [{ name: '1X', value: '1' }] }, 'extraEnv name'],
      [{ extraEnv: [{ name: 'PATH', value: '/tmp' }] }, 'PATH'],
      [{ extraEnv: 'A=1' }, 'array'],
    ];
    for (const [extra, text] of bad) {
      const r = await saveLlm(api, { provider: 'claude-code', ...extra });
      expect(r.status, text).toBe(400);
      expect(r.body.message, text).toContain(text);
    }
    expect(readFileSync(userSettingsPath(), 'utf8')).toBe(before);
  });

  it('keeps the command and extra variables when switching to an API provider', async () => {
    expect((await saveLlm(api, { provider: 'anthropic', apiKey: 'sk-SECRET-api-key-123456' })).status).toBe(200);
    expect(userSettings().llm).toMatchObject({ provider: 'anthropic', command: FAKE_CLAUDE, extraEnv: { MY_TOKEN: TOKEN_VALUE } });
    expect((await saveLlm(api, { provider: 'claude-code', command: FAKE_CLAUDE })).status).toBe(200);
    expect(userSettings().llm).toEqual({ provider: 'claude-code', command: FAKE_CLAUDE, extraEnv: { MY_TOKEN: TOKEN_VALUE, NO_PROXY: 'localhost' } });
  });

  it('status gives the kind and the provider source', async () => {
    expect((await api<Status>('/api/status')).body).toMatchObject({ llmConfigured: true, llm: { provider: 'claude-code', model: '', kind: 'cli', source: 'user' }, llmProblem: null });
    const envApi = await start({ env: { CODEINSIGHT_LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-env' } });
    writeFileSync(userSettingsPath(), JSON.stringify({ recentRepos: [] }));
    expect((await envApi<Status>('/api/status')).body.llm).toMatchObject({ provider: 'anthropic', kind: 'api', source: 'env' });
  });
});

describe('opencode before its permissions are verified', () => {
  it('cannot be saved or tested, and status reports it as not configured with the reason', async () => {
    const api = await start({ env: { ...cliEnv(), CODEINSIGHT_LLM_PROVIDER: 'opencode' } });
    for (const call of [saveLlm, testLlm]) {
      const r = await call(api, { provider: 'opencode' });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('provider_unavailable');
    }
    const st = (await api<Status>('/api/status')).body;
    expect(st).toMatchObject({ llmConfigured: false, llm: null });
    expect(st.llmProblem).toContain('opencode');
    const s = (await api<SettingsView>('/api/settings')).body;
    expect(s.unavailableProviders).toEqual(['opencode']);
    expect(s.effective).toMatchObject({ configured: false, kind: 'cli' });
    expect(s.effective.problem).toContain('opencode');
  });
});

describe('testing a CLI connection', () => {
  const env = cliEnv();
  let api: Api;
  beforeAll(async () => {
    api = await start({ env, llmTestCliTimeoutMs: 1500 });
  });
  const run = (scenario: string, body: Record<string, unknown> = {}) => {
    env.FAKE_CLI_SCENARIO = scenario;
    return testLlm(api, { provider: 'claude-code', command: FAKE_CLAUDE, ...body });
  };

  it('succeeds with the version and sends one minimal request through stdin', async () => {
    const r = await run('ok-text', { model: 'claude-test-1' });
    expect(r.body).toMatchObject({ ok: true, provider: 'claude-code', model: 'claude-test-1', command: FAKE_CLAUDE, version: '2.1.318 (Claude Code)' });
    const rec = records(env).map((l) => JSON.parse(l) as { stdin: string; argv: string[] });
    expect(rec).toHaveLength(1);
    expect(rec[0]!.stdin).toContain('Reply with OK.');
    expect(rec[0]!.argv).toContain('--model=claude-test-1');
    expect((await run('ok-text')).body).toMatchObject({ ok: true, model: '' });
  });

  it('reports a missing command, a failing --version, quota and timeouts', async () => {
    expect((await run('ok-text', { command: '/nonexistent/dir/claude' })).body).toMatchObject({ ok: false, reason: 'command_not_found' });
    if (process.platform !== 'win32' && existsSync('/usr/bin/false')) {
      expect((await run('ok-text', { command: '/usr/bin/false' })).body).toMatchObject({ ok: false, reason: 'version_failed' });
    }
    expect((await run('billing')).body).toMatchObject({ ok: false, reason: 'quota' });
    const t = (await run('hang')).body;
    expect(t).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('stops at the login check without sending a model request; mentions apiKeyHelper when it is set', async () => {
    const before = records(env).length;
    const r = (await run('not-logged-in')).body;
    expect(r).toMatchObject({ ok: false, reason: 'not_logged_in' });
    expect(records(env)).toHaveLength(before);
    writeFileSync(path.join(env.CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify({ apiKeyHelper: '/usr/local/bin/get-key' }));
    expect((await run('not-logged-in')).body.message).toContain('apiKeyHelper');
    // 附加环境变量里有 key 时登录检查不算失败，交给实际调用
    const withKey = (await run('not-logged-in', { extraEnv: [{ name: 'ANTHROPIC_API_KEY', value: 'sk-SECRET-api-key-123456' }] })).body;
    expect(withKey).toMatchObject({ ok: false, reason: 'not_logged_in' });
    expect(records(env)).toHaveLength(before + 1);
  });
});

/** 发起测试连接后不等响应就断开，返回断开函数 */
function startAndDisconnect(server: RunningHttpServer, body: Record<string, unknown>): () => void {
  const data = JSON.stringify(body);
  const req = httpRequest({
    host: '127.0.0.1', port: server.port, path: '/api/settings/llm/test', method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.token}` },
  });
  req.on('error', () => undefined);
  req.end(data);
  return () => req.destroy();
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** 等假 CLI 开始运行（记录文件里出现新的一行），返回它的 pid */
async function runningPid(env: Record<string, string>, before: number): Promise<number> {
  const line = await waitFor(async () => records(env)[before], 10_000);
  return (JSON.parse(line) as { pid: number }).pid;
}

describe('cancelling a CLI connection test', () => {
  it('stops the CLI when the browser disconnects, so the next test is not refused', async () => {
    const env = { ...cliEnv(), FAKE_CLI_SCENARIO: 'hang' };
    const server = await startServer({ env, llmTestCliTimeoutMs: 60_000 });
    const disconnect = startAndDisconnect(server, { provider: 'claude-code', command: FAKE_CLAUDE });
    const pid = await runningPid(env, 0);
    disconnect();
    await waitFor(async () => (alive(pid) ? undefined : true), 10_000);
    env.FAKE_CLI_SCENARIO = 'ok-text';
    const api = apiFor(server);
    const next = await waitFor(async () => {
      const r = await api<TestResult & { error?: string }>('/api/settings/llm/test', { method: 'POST', body: { provider: 'claude-code', command: FAKE_CLAUDE } });
      return r.body.error === 'test_running' ? undefined : r.body;
    }, 10_000);
    expect(next.ok).toBe(true);
    expect(logLines.some((l) => l.includes(' llm_test ') && l.includes('cancelled=true'))).toBe(true);
  });

  it('stops the CLI when the server closes', async () => {
    const env = { ...cliEnv(), FAKE_CLI_SCENARIO: 'hang' };
    const server = await startServer({ env, llmTestCliTimeoutMs: 60_000 });
    startAndDisconnect(server, { provider: 'claude-code', command: FAKE_CLAUDE });
    const pid = await runningPid(env, 0);
    await server.close();
    await waitFor(async () => (alive(pid) ? undefined : true), 10_000);
  });

  it('also stops a hanging --version check when the server closes', async () => {
    const env = cliEnv();
    const command = path.join(env.CLAUDE_CONFIG_DIR!, 'claude-hangs');
    writeFileSync(command, "#!/usr/bin/env node\nrequire('fs').appendFileSync(process.env.FAKE_CLI_RECORD, JSON.stringify({ pid: process.pid }) + '\\n');\nsetInterval(() => {}, 1000);\n");
    chmodSync(command, 0o755);
    const server = await startServer({ env });
    startAndDisconnect(server, { provider: 'claude-code', command });
    const pid = await runningPid(env, 0);
    await server.close();
    await waitFor(async () => (alive(pid) ? undefined : true), 10_000);
  });
});

describe('repository config', () => {
  it('status reports the repository config as the provider source', async () => {
    const repo = shopRepo();
    writeFileSync(path.join(repo, 'codeinsight.config.json'), JSON.stringify({ llm: { provider: 'openai-compatible', model: 'repo-model' } }));
    writeFileSync(userSettingsPath(), JSON.stringify({ recentRepos: [] }));
    const env = { OPENAI_API_KEY: 'sk-env' };
    const ws = await openWorkspace(repo, tempDir('ci-cli-data-'), undefined, env);
    const api = await start({ workspace: ws, env });
    expect((await api<Status>('/api/status')).body.llm).toEqual({ provider: 'openai-compatible', model: 'repo-model', kind: 'api', source: 'repo' });
  });

  it('a command in the repository config is not a source', async () => {
    const repo = shopRepo();
    writeFileSync(path.join(repo, 'codeinsight.config.json'), JSON.stringify({ llm: { provider: 'claude-code', command: '/evil/claude' } }));
    const env = cliEnv();
    const ws = await openWorkspace(repo, tempDir('ci-cli-data-'), undefined, env);
    const api = await start({ workspace: ws, env });
    await saveLlm(api, { provider: 'claude-code' });
    const s = (await api<SettingsView>('/api/settings')).body;
    expect(s.llm.command).toMatchObject({ value: null, source: 'default' });
    expect(JSON.stringify(s)).not.toContain('/evil/claude');
  });
});

describe('secrets', () => {
  it('responses and logs carry names of extra variables but never the hidden values', () => {
    for (const b of bodies) {
      expect(b).not.toContain(TOKEN_VALUE);
      expect(b).not.toContain(PROXY_PASSWORD);
      expect(b).not.toContain('sk-SECRET-api-key-123456');
    }
    const saved = logLines.filter((l) => l.includes('user_settings_saved') && l.includes('claude-code'));
    expect(saved.some((l) => l.includes('MY_TOKEN'))).toBe(true);
    expect(logLines.some((l) => l.includes(' llm_test ') && l.includes('command=fake-claude.mjs version='))).toBe(true);
    for (const l of logLines) {
      expect(l).not.toContain(TOKEN_VALUE);
      expect(l).not.toContain(PROXY_PASSWORD);
      expect(l).not.toContain('sk-SECRET-api-key-123456');
    }
  });
});
