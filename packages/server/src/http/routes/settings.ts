import {
  ANTHROPIC_BASE_URL, createLlmClient, isLlmProvider, LlmError, LlmTruncatedError, loadConfig, loadLlmSources, log, OPENAI_BASE_URL, originOf,
  readUserSettings, updateUserSettings, userSettingsPath,
} from '@codeinsight/core';
import type { LlmClient, LlmConfig, LlmFieldSource, LlmProvider, LlmSources, UserLlmSettings, UserSettings } from '@codeinsight/core';
import type { RepoContext } from '../../repo-context.js';
import type { AppContext, Route, RequestContext } from '../context.js';
import { HttpError, optBool, readJsonBody, sendJson } from '../respond.js';

const MAX_BASE_URL_CHARS = 2048;
const MAX_MODEL_CHARS = 200;
const MAX_API_KEY_CHARS = 4096;
/** 显示末 4 位的最短 key 长度，太短的 key 不显示任何部分 */
const LAST4_MIN_CHARS = 12;

/** 保存和测试连接的请求体；空字符串的项为 undefined */
export interface LlmForm {
  provider: LlmProvider;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  clearApiKey: boolean;
}

type ApiKeyChange = 'set' | 'unchanged' | 'cleared';

function invalid(message: string): HttpError {
  return new HttpError(400, 'invalid_param', message);
}

/** 可选的字符串字段：不传、null、空白为 undefined，否则去掉首尾空白 */
function optText(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw invalid(`${key} must be a string`);
  return v.trim() === '' ? undefined : v.trim();
}

function parseBaseUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (raw.length > MAX_BASE_URL_CHARS) throw invalid(`baseUrl must be at most ${MAX_BASE_URL_CHARS} characters`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid('baseUrl must be a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid('baseUrl must use http or https');
  if (url.username || url.password) throw invalid('baseUrl must not contain a user name or password');
  return raw.replace(/\/+$/, '');
}

function parseModel(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (raw.length > MAX_MODEL_CHARS) throw invalid(`model must be at most ${MAX_MODEL_CHARS} characters`);
  if (/[\r\n]/.test(raw)) throw invalid('model must not contain line breaks');
  return raw;
}

/** 错误信息里不带 key 的任何部分 */
function parseApiKey(raw: string | undefined, clear: boolean): string | undefined {
  if (raw === undefined) return undefined;
  if (clear) throw invalid('apiKey and clearApiKey cannot be used together');
  if (raw.length > MAX_API_KEY_CHARS) throw invalid(`apiKey must be at most ${MAX_API_KEY_CHARS} characters`);
  if (/\s/.test(raw)) throw invalid('apiKey must not contain whitespace');
  return raw;
}

export function parseLlmForm(body: Record<string, unknown>): LlmForm {
  const provider = body.provider;
  if (!isLlmProvider(provider)) throw invalid('provider must be anthropic or openai-compatible');
  const clearApiKey = optBool(body, 'clearApiKey') ?? false;
  return {
    provider,
    baseUrl: parseBaseUrl(optText(body, 'baseUrl')),
    model: parseModel(optText(body, 'model')),
    apiKey: parseApiKey(optText(body, 'apiKey'), clearApiKey),
    clearApiKey,
  };
}

function apiKeyChange(form: LlmForm): ApiKeyChange {
  if (form.clearApiKey) return 'cleared';
  return form.apiKey ? 'set' : 'unchanged';
}

/** 请求日志里的参数：apiKey 只记怎么改，baseUrl 只记 origin */
function formLogFields(form: LlmForm): Record<string, unknown> {
  return { provider: form.provider, baseUrlOrigin: form.baseUrl ? originOf(form.baseUrl) : undefined, model: form.model, apiKey: apiKeyChange(form) };
}

/** 已保存的 key 属于哪个 provider：用户设置里的，没有时为当时生效的 */
async function savedKeyProvider(ctx: RequestContext, settings: UserSettings): Promise<string | undefined> {
  return settings.llm?.provider ?? (await sourcesFor(ctx.app, ctx.repo, settings)).provider.value;
}

/**
 * 按表单得到新的用户 LLM 设置和保存后生效的取值：baseUrl、model 为空表示不保存；apiKey 为空时沿用已保存的，
 * 但 provider 变了时不沿用（避免把一家的 key 发给另一家、盖住该 provider 的环境变量），这时要有该 provider 的环境变量 key，否则 400。
 */
async function resolveUserLlm(ctx: RequestContext, settings: UserSettings, form: LlmForm): Promise<{ llm: UserLlmSettings; sources: LlmSources }> {
  const saved = settings.llm?.apiKey;
  let apiKey = form.clearApiKey ? undefined : (form.apiKey ?? saved);
  const dropped = !form.apiKey && !form.clearApiKey && saved !== undefined && (await savedKeyProvider(ctx, settings)) !== form.provider;
  if (dropped) apiKey = undefined;
  const llm: UserLlmSettings = { provider: form.provider, baseUrl: form.baseUrl, model: form.model, apiKey };
  const sources = await sourcesFor(ctx.app, ctx.repo, { ...settings, llm });
  if (dropped && sources.apiKey.value === undefined) {
    throw invalid('apiKey is required: the saved key belongs to another provider');
  }
  if (dropped) log.info('user_settings_key_not_reused', { provider: form.provider, keySource: sources.apiKey.source, env: sources.apiKey.env });
  return { llm, sources };
}

function sourceView(f: LlmFieldSource, value: string | undefined = f.value) {
  return { value: value ?? null, source: f.source, ...(f.env ? { env: f.env } : {}) };
}

function defaultBaseUrl(provider: string | undefined): string | undefined {
  if (provider === 'anthropic') return ANTHROPIC_BASE_URL;
  return provider === 'openai-compatible' ? OPENAI_BASE_URL : undefined;
}

/** apiKey 只给是否设置、足够长时的末 4 位和来源 */
function apiKeyView(f: LlmFieldSource) {
  const key = f.value ?? '';
  return { set: key !== '', ...(key.length >= LAST4_MIN_CHARS ? { last4: key.slice(-4) } : {}), source: f.source, ...(f.env ? { env: f.env } : {}) };
}

function llmView(s: LlmSources) {
  const baseUrl = s.baseUrl.source === 'default' ? defaultBaseUrl(s.provider.value) : s.baseUrl.value;
  return {
    llm: {
      provider: sourceView(s.provider), baseUrl: sourceView(s.baseUrl, baseUrl), model: sourceView(s.model), apiKey: apiKeyView(s.apiKey),
      shadowed: s.shadowed,
    },
    effective: { configured: s.llm !== undefined, provider: s.llm?.provider ?? null, model: s.llm?.model ?? null, problem: s.problem ?? null },
  };
}

/** 有当前仓库时读它的仓库配置（provider、model 可能来自它），没有时不读 */
function sourcesFor(app: AppContext, repo: RepoContext | undefined, settings: UserSettings): Promise<LlmSources> {
  return loadLlmSources(repo?.ws.repo, { env: app.env, userSettings: settings });
}

/** GET /api/settings 的结构；不含 apiKey 原文 */
async function settingsView(ctx: RequestContext, settings?: UserSettings) {
  const s = settings ?? (await readUserSettings());
  const sources = await sourcesFor(ctx.app, ctx.repo, s);
  return { path: userSettingsPath(), ...llmView(sources), autoReindex: s.autoReindex ?? false };
}

/** 用新的用户设置重新读当前仓库的配置并替换（数据目录不变）；已开始的任务继续用旧配置 */
export async function refreshRepoConfig(app: AppContext): Promise<void> {
  const cur = app.repo;
  if (!cur || cur.closing) return;
  try {
    cur.ws.config = await loadConfig(cur.ws.repo, { dataDir: cur.ws.config.dataDir, env: app.env });
    const llm = cur.ws.config.llm;
    log.info('repo_config_reloaded', { repo: cur.ws.repo, gen: cur.gen, provider: llm?.provider, model: llm?.model });
  } catch (err) {
    log.warn('repo_config_reload_failed', { repo: cur.ws.repo, error: (err as Error).message });
  }
}

async function getSettings(ctx: RequestContext): Promise<void> {
  sendJson(ctx.res, 200, await settingsView(ctx));
}

/** POST /api/settings/llm：保存模型服务设置并刷新当前仓库的配置 */
async function saveLlm(ctx: RequestContext): Promise<void> {
  const form = parseLlmForm(await readJsonBody(ctx.req));
  const fields = formLogFields(form);
  Object.assign(ctx.logFields, fields);
  const { llm } = await resolveUserLlm(ctx, await readUserSettings(), form);
  const settings = await updateUserSettings((s) => ({ ...s, llm }));
  log.info('user_settings_saved', fields);
  await refreshRepoConfig(ctx.app);
  sendJson(ctx.res, 200, await settingsView(ctx, settings));
}

/** POST /api/settings `{autoReindex}`：通用设置 */
async function saveGeneral(ctx: RequestContext): Promise<void> {
  const autoReindex = optBool(await readJsonBody(ctx.req), 'autoReindex');
  if (autoReindex === undefined) throw invalid('autoReindex must be a boolean');
  ctx.logFields.autoReindex = autoReindex;
  const settings = await updateUserSettings((s) => ({ ...s, autoReindex }));
  log.info('user_settings_saved', { autoReindex });
  sendJson(ctx.res, 200, await settingsView(ctx, settings));
}

export type LlmTestResult =
  | { ok: true; provider: string; model: string; origin: string; ms: number }
  | { ok: false; reason: string; message: string; ms: number };

const PING = { system: '', messages: [{ role: 'user' as const, content: 'ping' }], maxTokens: 16 };

/** 请求失败的原因分类；message 只用 LlmError 自己的文字（不含响应体原文和 key） */
function failureReason(err: unknown, ms: number, timeoutMs: number): string {
  if (!(err instanceof LlmError)) return 'bad_response';
  const status = err.status;
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status !== undefined) return status >= 200 && status < 300 ? 'bad_response' : `http_${status}`;
  if (!err.message.startsWith('request to ')) return 'bad_response';
  return /timeout/i.test(err.message) || ms >= timeoutMs ? 'timeout' : 'network';
}

function cfgOrigin(cfg: LlmConfig): string {
  return originOf(cfg.baseUrl ?? defaultBaseUrl(cfg.provider) ?? '');
}

/** 发一个最小请求；收到回复（包括被截断）就算成功 */
async function pingLlm(cfg: LlmConfig, timeoutMs: number): Promise<LlmTestResult> {
  let client: LlmClient;
  try {
    client = createLlmClient(cfg, { timeoutMs });
  } catch (err) {
    return { ok: false, reason: 'missing_key', message: (err as Error).message, ms: 0 };
  }
  const started = Date.now();
  try {
    await client.complete(PING);
  } catch (err) {
    const ms = Date.now() - started;
    if (!(err instanceof LlmTruncatedError)) return { ok: false, reason: failureReason(err, ms, timeoutMs), message: (err as Error).message.slice(0, 300), ms };
  }
  return { ok: true, provider: cfg.provider, model: cfg.model, origin: cfgOrigin(cfg), ms: Date.now() - started };
}

/** 按“保存后会生效的配置”测试：表单没填的项按用户设置、环境变量、仓库配置、默认值补齐 */
async function runLlmTest(ctx: RequestContext, form: LlmForm): Promise<{ result: LlmTestResult; cfg?: LlmConfig }> {
  const { sources } = await resolveUserLlm(ctx, await readUserSettings(), form);
  if (!sources.llm) return { result: { ok: false, reason: 'invalid_config', message: sources.problem ?? 'LLM is not configured', ms: 0 } };
  return { result: await pingLlm(sources.llm, ctx.app.llmTest.timeoutMs), cfg: sources.llm };
}

/** POST /api/settings/llm/test：不写文件；同一时间只允许一个测试 */
async function testLlm(ctx: RequestContext): Promise<void> {
  const form = parseLlmForm(await readJsonBody(ctx.req));
  Object.assign(ctx.logFields, formLogFields(form));
  const state = ctx.app.llmTest;
  if (state.running) throw new HttpError(409, 'test_running', 'a connection test is already running');
  state.running = true;
  try {
    const { result, cfg } = await runLlmTest(ctx, form);
    log.info('llm_test', { provider: cfg?.provider ?? form.provider, origin: cfg ? cfgOrigin(cfg) : undefined, model: cfg?.model, ok: result.ok, reason: result.ok ? undefined : result.reason, ms: result.ms });
    Object.assign(ctx.logFields, { ok: result.ok, reason: result.ok ? undefined : result.reason });
    sendJson(ctx.res, 200, result);
  } finally {
    state.running = false;
  }
}

export const settingsRoutes: Route[] = [
  { method: 'GET', pattern: '/api/settings', handler: getSettings, needsRepo: false },
  { method: 'POST', pattern: '/api/settings', handler: saveGeneral, needsRepo: false },
  { method: 'POST', pattern: '/api/settings/llm', handler: saveLlm, needsRepo: false },
  { method: 'POST', pattern: '/api/settings/llm/test', handler: testLlm, needsRepo: false },
];
