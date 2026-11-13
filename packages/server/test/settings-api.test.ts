import { readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANTHROPIC_BASE_URL, DEFAULT_ANTHROPIC_MODEL, setLogSink, userSettingsPath } from '@codeinsight/core';
import { startHttpServer, type HttpServerOptions, type RunningHttpServer, type ServerWorkspace } from '../src/index.js';
import { overviewReply, startFakeLlm, type FakeLlm, type FakeLlmRequest } from '../../core/test/helpers/fake-llm-server.mjs';
import { indexReady, openWorkspace, request, shopRepo, tempDir, waitFor, type Api } from './helpers/env.js';

const KEY = 'sk-user-SECRET-0123456789wxyz';
const ENV_KEY = 'sk-env-SECRET-9876543210abcd';

interface FieldView { value: string | null; source: string; env?: string }
interface SettingsView {
  path: string;
  llm: {
    provider: FieldView; baseUrl: FieldView; model: FieldView;
    apiKey: { set: boolean; last4?: string; source: string; env?: string };
    shadowed: { field: string; by: string; env: string }[];
    commandEnv?: string | null;
  };
  effective: { configured: boolean; provider: string | null; model: string | null; problem: string | null };
  autoReindex: boolean;
}
interface Status {
  repo: string | null; llmConfigured: boolean; llm: { provider: string; model: string } | null; sendSource: boolean;
  changes: { checkedAt: number | null; codeChanged: boolean; autoReindex: boolean; autoReindexFailed: boolean };
}
interface TestResult { ok: boolean; reason?: string; message?: string; provider?: string; model?: string; origin?: string }

const prevLevel = process.env.CODEINSIGHT_LOG;
const logLines: string[] = [];
/** 所有接口响应体原文，最后检查不含 key */
const bodies: string[] = [];
let restoreSink: ((line: string) => void) | undefined;
let fake: FakeLlm;
let gate: Promise<void> | undefined;
const servers: RunningHttpServer[] = [];

/** 按请求里的模型名决定假 LLM 的回复 */
async function replyFor(req: FakeLlmRequest) {
  const model = String(req.body.model);
  if (model === 'hold') await gate;
  if (model === 'auth') return { status: 401, errorType: 'authentication_error' };
  if (model === 'missing') return { status: 404 };
  if (model === 'slow') await sleep(1500);
  if (model === 'trunc') return { text: 'p', truncated: true };
  if (model === 'garbage') return { status: 200, body: 'not json' };
  return model.startsWith('ov-') ? (await gate, overviewReply(req)) : 'pong';
}

function apiOf(server: RunningHttpServer): Api {
  return async <T>(rawPath: string, opts: { method?: string; body?: unknown } = {}) => {
    const res = await request(server.port, rawPath, { ...opts, headers: { Authorization: `Bearer ${server.token}` } });
    bodies.push(res.body);
    return { status: res.status, body: res.body ? res.json<T>() : ({} as T) };
  };
}

async function start(opts: HttpServerOptions): Promise<{ server: RunningHttpServer; api: Api }> {
  const server = await startHttpServer({ indexOnStart: false, dirPicker: { tool: null }, ...opts });
  servers.push(server);
  return { server, api: apiOf(server) };
}

const saveLlm = (api: Api, body: Record<string, unknown>) => api<SettingsView>('/api/settings/llm', { method: 'POST', body });
const testLlm = (api: Api, body: Record<string, unknown>) => api<TestResult>('/api/settings/llm/test', { method: 'POST', body });

/** 从用户设置文件里去掉模型服务配置，后面的用例从未配置开始 */
function clearUserLlm(): void {
  const s = JSON.parse(readFileSync(userSettingsPath(), 'utf8')) as Record<string, unknown>;
  delete s.llm;
  writeFileSync(userSettingsPath(), JSON.stringify(s));
}

beforeAll(async () => {
  process.env.CODEINSIGHT_LOG = 'debug';
  restoreSink = setLogSink((line) => logLines.push(line));
  fake = await startFakeLlm({ reply: replyFor });
});

afterAll(async () => {
  for (const s of servers) await s.close();
  await fake?.close();
  if (restoreSink) setLogSink(restoreSink);
  if (prevLevel === undefined) delete process.env.CODEINSIGHT_LOG;
  else process.env.CODEINSIGHT_LOG = prevLevel;
});

describe('settings api without a repository', () => {
  it('reports env sources and defaults, and status follows user settings and env', async () => {
    const { api } = await start({ env: { CODEINSIGHT_LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: ENV_KEY, CODEINSIGHT_SEND_SOURCE: '0', CODEINSIGHT_LLM_COMMAND: '/opt/tools/claude' } });
    const s = (await api<SettingsView>('/api/settings')).body;
    expect(s.llm.commandEnv).toBe('/opt/tools/claude');
    expect(s.path).toBe(userSettingsPath());
    expect(s.llm.provider).toEqual({ value: 'anthropic', source: 'env', env: 'CODEINSIGHT_LLM_PROVIDER' });
    expect(s.llm.model).toEqual({ value: DEFAULT_ANTHROPIC_MODEL, source: 'default' });
    expect(s.llm.baseUrl).toEqual({ value: ANTHROPIC_BASE_URL, source: 'default' });
    expect(s.llm.apiKey).toEqual({ set: true, last4: ENV_KEY.slice(-4), source: 'env', env: 'ANTHROPIC_API_KEY' });
    expect(s.effective).toEqual({ configured: true, kind: 'api', provider: 'anthropic', model: DEFAULT_ANTHROPIC_MODEL, problem: null });
    expect(s.autoReindex).toBe(false);
    const st = (await api<Status>('/api/status')).body;
    expect(st).toMatchObject({ repo: null, llmConfigured: true, llm: { provider: 'anthropic', model: DEFAULT_ANTHROPIC_MODEL }, sendSource: false });
    expect(st.changes).toEqual({ checkedAt: null, codeChanged: false, autoReindex: false, autoReindexFailed: false });

    const saved = await saveLlm(api, { provider: 'anthropic', model: 'user-model' });
    expect(saved.body.llm.model).toEqual({ value: 'user-model', source: 'user' });
    expect((await api<Status>('/api/status')).body.llm).toEqual({ provider: 'anthropic', model: 'user-model', kind: 'api', source: 'user' });
    clearUserLlm();
    expect((await api<SettingsView>('/api/settings')).body).toMatchObject({ llm: { model: { source: 'default' } } });
  });

  it('saves the general settings', async () => {
    const { api } = await start({ env: {} });
    expect((await api('/api/settings', { method: 'POST', body: { autoReindex: 'yes' } })).status).toBe(400);
    expect((await api('/api/settings', { method: 'POST', body: {} })).status).toBe(400);
    const r = await api<SettingsView>('/api/settings', { method: 'POST', body: { autoReindex: true } });
    expect(r.body.autoReindex).toBe(true);
    expect((await api<Status>('/api/status')).body.changes.autoReindex).toBe(true);
    await api('/api/settings', { method: 'POST', body: { autoReindex: false } });
  });
});

describe('settings api with a repository', () => {
  let ws: ServerWorkspace;
  let api: Api;
  const env = { CODEINSIGHT_LLM_MODEL: 'env-model' };

  beforeAll(async () => {
    ws = await openWorkspace(shopRepo(), tempDir('ci-settings-data-'), undefined, env);
    ({ api } = await start({ workspace: ws, env, indexOnStart: true }));
    await indexReady(api);
  });

  it('saves the LLM settings, lists shadowed env values and refreshes the repository config', async () => {
    expect((await api<Status>('/api/status')).body.llmConfigured).toBe(false);
    const r = await saveLlm(api, { provider: 'openai-compatible', baseUrl: `${fake.url}/`, model: 'user-model', apiKey: KEY });
    expect(r.status).toBe(200);
    expect(r.body.llm.provider).toEqual({ value: 'openai-compatible', source: 'user' });
    expect(r.body.llm.baseUrl).toEqual({ value: fake.url, source: 'user' });
    expect(r.body.llm.model).toEqual({ value: 'user-model', source: 'user' });
    expect(r.body.llm.apiKey).toEqual({ set: true, last4: KEY.slice(-4), source: 'user' });
    expect(r.body.llm.shadowed).toEqual([{ field: 'model', by: 'user', env: 'CODEINSIGHT_LLM_MODEL' }]);
    expect((await api<Status>('/api/status')).body.llm).toEqual({ provider: 'openai-compatible', model: 'user-model', kind: 'api', source: 'user' });
    expect(ws.config.llm).toMatchObject({ baseUrl: fake.url, apiKey: KEY });
    expect(ws.config.dataDir).toContain('ci-settings-data-');
  });

  it('keeps the key when apiKey is empty and removes it with clearApiKey', async () => {
    const kept = await saveLlm(api, { provider: 'openai-compatible', baseUrl: fake.url, model: 'user-model-2', apiKey: '' });
    expect(kept.body.llm.apiKey).toMatchObject({ set: true, last4: KEY.slice(-4) });
    expect(JSON.parse(readFileSync(userSettingsPath(), 'utf8')).llm.apiKey).toBe(KEY);
    const cleared = await saveLlm(api, { provider: 'openai-compatible', baseUrl: fake.url, model: 'user-model-2', clearApiKey: true });
    expect(cleared.body.llm.apiKey).toEqual({ set: false, source: 'none' });
    expect(JSON.parse(readFileSync(userSettingsPath(), 'utf8')).llm.apiKey).toBeUndefined();
    await saveLlm(api, { provider: 'openai-compatible', baseUrl: fake.url, model: 'user-model-2', apiKey: KEY });
  });

  it('accepts model names with @, /, . and :', async () => {
    const model = '@cf/meta/llama-3.1-8b-instruct:free';
    const r = await saveLlm(api, { provider: 'openai-compatible', baseUrl: fake.url, model, apiKey: '' });
    expect(r.status).toBe(200);
    expect(r.body.llm.model).toEqual({ value: model, source: 'user' });
    expect(JSON.parse(readFileSync(userSettingsPath(), 'utf8')).llm.model).toBe(model);
    await saveLlm(api, { provider: 'openai-compatible', baseUrl: fake.url, model: 'user-model-2', apiKey: '' });
  });

  it('rejects invalid parameters without echoing the key', async () => {
    const bad: [Record<string, unknown>, string][] = [
      [{ provider: 'other' }, 'provider'],
      [{ provider: 'anthropic', baseUrl: 'ftp://x.example' }, 'baseUrl'],
      [{ provider: 'anthropic', baseUrl: 'not a url' }, 'baseUrl'],
      [{ provider: 'anthropic', baseUrl: 'https://u:p@x.example' }, 'baseUrl'],
      [{ provider: 'anthropic', baseUrl: `https://x.example/${'a'.repeat(2048)}` }, 'baseUrl'],
      [{ provider: 'anthropic', model: 'a\nb' }, 'model'],
      [{ provider: 'anthropic', model: 'm'.repeat(201) }, 'model'],
      [{ provider: 'anthropic', model: '-m' }, 'model'],
      [{ provider: 'anthropic', model: 'a b' }, 'model'],
      [{ provider: 'anthropic', apiKey: `${KEY} x` }, 'apiKey'],
      [{ provider: 'anthropic', apiKey: 'k'.repeat(4097) }, 'apiKey'],
      [{ provider: 'anthropic', apiKey: KEY, clearApiKey: true }, 'apiKey'],
      [{ provider: 'anthropic', clearApiKey: 'yes' }, 'clearApiKey'],
    ];
    for (const [body, field] of bad) {
      const r = await api<{ error: string; message: string }>('/api/settings/llm', { method: 'POST', body });
      expect(r.status, field).toBe(400);
      expect(r.body.error).toBe('invalid_param');
      expect(r.body.message).toContain(field);
      expect((await testLlm(api, body)).status, field).toBe(400);
    }
    expect((await api<SettingsView>('/api/settings')).body.llm.model.value).toBe('user-model-2');
  });

  it('tests the connection without writing the settings file', async () => {
    const before = readFileSync(userSettingsPath(), 'utf8');
    const base = { provider: 'openai-compatible', baseUrl: fake.url };
    expect((await testLlm(api, { ...base, model: 'ok' })).body).toMatchObject({ ok: true, provider: 'openai-compatible', model: 'ok', origin: fake.url });
    expect(fake.requests.at(-1)!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect((await testLlm(api, { ...base, model: 'trunc' })).body.ok).toBe(true);
    expect((await testLlm(api, { ...base, model: 'auth' })).body).toMatchObject({ ok: false, reason: 'auth' });
    expect((await testLlm(api, { ...base, model: 'missing' })).body).toMatchObject({ ok: false, reason: 'not_found' });
    expect((await testLlm(api, { ...base, model: 'garbage' })).body).toMatchObject({ ok: false, reason: 'bad_response' });
    expect((await testLlm(api, { provider: 'anthropic', baseUrl: fake.url, clearApiKey: true })).body).toMatchObject({ ok: false, reason: 'missing_key' });
    expect((await testLlm(api, { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9', model: 'ok' })).body).toMatchObject({ ok: false, reason: 'network' });
    expect(readFileSync(userSettingsPath(), 'utf8')).toBe(before);
  });

  it('reports timeouts and allows one test at a time', async () => {
    const quick = await start({ env: {}, llmTestTimeoutMs: 300 });
    const base = { provider: 'openai-compatible', baseUrl: fake.url, apiKey: KEY };
    expect((await testLlm(quick.api, { ...base, model: 'slow' })).body).toMatchObject({ ok: false, reason: 'timeout' });
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    const first = testLlm(api, { ...base, model: 'hold' });
    await waitFor(async () => (fake.requests.some((r) => r.body.model === 'hold' && !r.aborted) ? true : undefined));
    expect((await testLlm(api, { ...base, model: 'ok' })).body).toMatchObject({ error: 'test_running' });
    release();
    expect((await first).body.ok).toBe(true);
    gate = undefined;
  });

  it('aborts the API request when the browser disconnects, so the next test is not 409', async () => {
    const { server, api: own } = await start({ env: {} });
    gate = new Promise<void>(() => undefined);
    const body = JSON.stringify({ provider: 'openai-compatible', baseUrl: fake.url, apiKey: KEY, model: 'hold' });
    const req = httpRequest({
      host: '127.0.0.1', port: server.port, path: '/api/settings/llm/test', method: 'POST',
      headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    req.on('error', () => undefined);
    req.end(body);
    const held = () => fake.requests.filter((r) => r.body.model === 'hold');
    const before = held().length;
    await waitFor(async () => (held().length > before ? true : undefined));
    req.destroy();
    await waitFor(async () => (held().at(-1)!.aborted ? true : undefined));
    gate = undefined;
    const next = await testLlm(own, { provider: 'openai-compatible', baseUrl: fake.url, apiKey: KEY, model: 'ok' });
    expect(next.status).toBe(200);
    expect(next.body.ok).toBe(true);
  });

  it('reports invalid configurations', async () => {
    const { api: noEnv } = await start({ env: {} });
    await saveLlm(noEnv, { provider: 'openai-compatible', baseUrl: fake.url });
    expect((await testLlm(noEnv, { provider: 'openai-compatible', baseUrl: fake.url })).body).toMatchObject({ ok: false, reason: 'invalid_config' });
    await saveLlm(api, { provider: 'openai-compatible', baseUrl: fake.url, model: 'user-model-2', apiKey: KEY });
  });

  it('keeps the old config for a running overview', async () => {
    await saveLlm(api, { provider: 'anthropic', baseUrl: fake.url, model: 'ov-old', apiKey: KEY });
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    const started = await api<{ id: number }>('/api/overview', { method: 'POST', body: { confirmed: true } });
    expect(started.status).toBe(202);
    await waitFor(async () => (fake.requests.some((r) => r.body.model === 'ov-old') ? true : undefined));
    await saveLlm(api, { provider: 'anthropic', baseUrl: fake.url, model: 'ov-new', apiKey: KEY });
    expect((await api<Status>('/api/status')).body.llm?.model).toBe('ov-new');
    release();
    gate = undefined;
    await waitFor(async () => {
      const j = (await api<{ status: string }>(`/api/overview/jobs/${started.body.id}`)).body;
      return j.status === 'running' ? undefined : j.status;
    });
    const models = new Set(fake.requests.filter((r) => String(r.body.model).startsWith('ov-')).map((r) => r.body.model));
    expect([...models]).toEqual(['ov-old']);
  });

  it('never returns or logs the API key', () => {
    expect(bodies.length).toBeGreaterThan(20);
    for (const b of bodies) expect(b).not.toContain(KEY);
    for (const b of bodies) expect(b).not.toContain(ENV_KEY);
    expect(logLines.some((l) => l.includes('user_settings_saved'))).toBe(true);
    expect(logLines.some((l) => l.includes('llm_test'))).toBe(true);
    for (const l of logLines) {
      expect(l).not.toContain(KEY);
      expect(l).not.toContain(ENV_KEY);
    }
  });
});

describe('switching the provider with an empty apiKey', () => {
  it('does not reuse the saved key of another provider and falls back to that provider\'s env key', async () => {
    const { api } = await start({ env: { OPENAI_API_KEY: ENV_KEY } });
    await saveLlm(api, { provider: 'anthropic', apiKey: KEY });
    const body = { provider: 'openai-compatible', baseUrl: fake.url, model: 'ok' };
    expect((await testLlm(api, body)).body.ok).toBe(true);
    expect(fake.requests.at(-1)!.headers.authorization).toBe(`Bearer ${ENV_KEY}`);
    const saved = await saveLlm(api, body);
    expect(saved.status).toBe(200);
    expect(saved.body.llm.apiKey).toEqual({ set: true, last4: ENV_KEY.slice(-4), source: 'env', env: 'OPENAI_API_KEY' });
    expect(JSON.parse(readFileSync(userSettingsPath(), 'utf8')).llm.apiKey).toBeUndefined();
  });

  it('answers 400 when the new provider has no key anywhere', async () => {
    const { api } = await start({ env: {} });
    await saveLlm(api, { provider: 'anthropic', apiKey: KEY });
    const before = readFileSync(userSettingsPath(), 'utf8');
    const body = { provider: 'openai-compatible', baseUrl: fake.url, model: 'ok' };
    const requests = fake.requests.length;
    for (const r of [await testLlm(api, body), await saveLlm(api, body)]) {
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ error: 'invalid_param', message: expect.stringContaining('apiKey') });
    }
    expect(fake.requests.length).toBe(requests);
    expect(readFileSync(userSettingsPath(), 'utf8')).toBe(before);
    // 同一 provider 留空仍沿用已保存的 key
    expect((await saveLlm(api, { provider: 'anthropic', model: 'm' })).body.llm.apiKey).toMatchObject({ set: true, source: 'user' });
    for (const b of bodies) expect(b).not.toContain(KEY);
    for (const l of logLines) expect(l).not.toContain(KEY);
  });
});

describe('status reading the settings file', () => {
  it('reads and warns once while the file is unchanged, and picks up changes', async () => {
    const { api } = await start({ env: {} });
    writeFileSync(userSettingsPath(), '{ broken');
    const count = () => logLines.filter((l) => l.includes('user_settings_invalid')).length;
    const before = count();
    for (let i = 0; i < 3; i++) expect((await api<Status>('/api/status')).body.changes.autoReindex).toBe(false);
    expect(count()).toBe(before + 1);
    writeFileSync(userSettingsPath(), JSON.stringify({ version: 1, autoReindex: true, recentRepos: [] }));
    expect((await api<Status>('/api/status')).body.changes.autoReindex).toBe(true);
    expect(count()).toBe(before + 1);
  });
});

describe('settings saved by another serve process', () => {
  it('refreshes the repository config when status sees the settings file changed', async () => {
    writeFileSync(userSettingsPath(), JSON.stringify({ version: 1, recentRepos: [] }));
    const repo = shopRepo();
    const wsA = await openWorkspace(repo, tempDir('ci-settings-a-'), undefined, {});
    const wsB = await openWorkspace(repo, tempDir('ci-settings-b-'), undefined, {});
    const a = await start({ workspace: wsA, env: {} });
    const b = await start({ workspace: wsB, env: {} });
    expect((await a.api<Status>('/api/status')).body.llmConfigured).toBe(false);
    expect((await b.api<Status>('/api/status')).body.llmConfigured).toBe(false);
    // 保证 mtime 不同
    await sleep(20);
    expect((await saveLlm(b.api, { provider: 'openai-compatible', baseUrl: fake.url, model: 'other-proc', apiKey: KEY })).status).toBe(200);
    expect((await a.api<Status>('/api/status')).body.llm).toEqual({ provider: 'openai-compatible', model: 'other-proc', kind: 'api', source: 'user' });
    expect(wsA.config.llm).toMatchObject({ model: 'other-proc' });
    clearUserLlm();
  });
});

describe('settings api auth', () => {
  it('requires the token and an allowed Origin on the new endpoints', async () => {
    const { server } = await start({ env: {} });
    const endpoints: [string, string][] = [
      ['GET', '/api/settings'], ['POST', '/api/settings'], ['POST', '/api/settings/llm'],
      ['POST', '/api/settings/llm/test'], ['POST', '/api/repo/pick-dir'],
    ];
    for (const [method, p] of endpoints) {
      expect((await request(server.port, p, { method })).status, p).toBe(401);
      const bad = await request(server.port, p, { method, headers: { Authorization: `Bearer ${server.token}`, Origin: 'http://evil.example' } });
      expect(bad.status, p).toBe(403);
    }
  });
});

