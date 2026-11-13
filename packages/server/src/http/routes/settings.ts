import path from 'node:path';
import {
  ANTHROPIC_BASE_URL, commandProblem, createLlmClient, envNameProblem, envValueProblem, isCliProvider, isLlmProvider, LlmError, LlmTruncatedError, loadConfig,
  LLM_ENV, loadLlmSources, log, MAX_EXTRA_ENV_ENTRIES, modelProblem, OPENAI_BASE_URL, OPENCODE_PERMISSIONS_VERIFIED, originOf, readUserSettings, resolveCliCommand,
  updateUserSettings, userSettingsPath,
} from '@codeinsight/core';
import type { LlmClient, LlmConfig, LlmExtraEnvSource, LlmFieldSource, LlmProvider, LlmSources, UserLlmSettings, UserSettings } from '@codeinsight/core';
import type { RepoContext } from '../../repo-context.js';
import type { AppContext, Route, RequestContext } from '../context.js';
import { HttpError, optBool, readJsonBody, sendJson } from '../respond.js';
import { testCliConnection, type CliTestResult } from './llm-test-cli.js';

const MAX_BASE_URL_CHARS = 2048;
const MAX_API_KEY_CHARS = 4096;
/** 显示末 4 位的最短 key 长度，太短的 key 不显示任何部分 */
const LAST4_MIN_CHARS = 12;

/** 附加环境变量的一项；没有 value 表示沿用已保存的同名值（网页上看不到值的项） */
export interface ExtraEnvEntry {
  name: string;
  value?: string;
}

/** 保存和测试连接的请求体；空字符串的项为 undefined */
export interface LlmForm {
  provider: LlmProvider;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  clearApiKey: boolean;
  /** 只用于 CLI provider */
  command?: string;
  /** 只用于 CLI provider；完整列表，整体替换；不传时沿用已保存的 */
  extraEnv?: ExtraEnvEntry[];
}

/** 回传值的代理变量（不分大小写），值按 URL 处理；NO_PROXY 是主机列表，原样回传 */
const PROXY_ENV = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']);

/** 权限隔离还没有在真实 CLI 上确认生效的 provider 不能选择 */
export function unavailableProviders(): LlmProvider[] {
  return OPENCODE_PERMISSIONS_VERIFIED ? [] : ['opencode'];
}

/** provider 暂不可用时的原因，可用时为 undefined */
export function providerUnavailable(provider: string | undefined): string | undefined {
  if (!unavailableProviders().includes(provider as LlmProvider)) return undefined;
  return `${provider} is not available yet: its permission isolation has not been verified for this version`;
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
  const problem = modelProblem(raw);
  if (problem) throw invalid(`model: ${problem}`);
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

function parseCommand(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const problem = commandProblem(raw, { pathOrName: true });
  if (problem) throw invalid(`command: ${problem}`);
  return raw;
}

function parseExtraEnvEntry(raw: unknown, seen: Set<string>): ExtraEnvEntry {
  const item = raw as { name?: unknown; value?: unknown } | null;
  if (typeof item !== 'object' || item === null || typeof item.name !== 'string') throw invalid('extraEnv items must be objects with a name');
  const name = item.name.trim();
  const nameProblem = envNameProblem(name);
  if (nameProblem) throw invalid(`extraEnv name ${JSON.stringify(name.slice(0, 64))}: ${nameProblem}`);
  if (seen.has(name)) throw invalid(`extraEnv name ${name} appears more than once`);
  seen.add(name);
  if (item.value === undefined || item.value === null) return { name };
  const valueProblem = envValueProblem(item.value);
  if (valueProblem) throw invalid(`extraEnv value of ${name}: ${valueProblem}`);
  return { name, value: item.value as string };
}

/** 附加环境变量：不传为 undefined（沿用已保存的）；错误信息只带名字，不带值 */
function parseExtraEnv(raw: unknown): ExtraEnvEntry[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw invalid('extraEnv must be an array');
  if (raw.length > MAX_EXTRA_ENV_ENTRIES) throw invalid(`extraEnv must have at most ${MAX_EXTRA_ENV_ENTRIES} items`);
  const seen = new Set<string>();
  return raw.map((item) => parseExtraEnvEntry(item, seen));
}

/** CLI provider 用本机登录状态，不接受服务地址和 API key */
function parseCliForm(body: Record<string, unknown>, provider: LlmProvider): LlmForm {
  if (optText(body, 'baseUrl') !== undefined) throw invalid(`baseUrl must be empty for ${provider}`);
  if (optText(body, 'apiKey') !== undefined) throw invalid(`apiKey must be empty for ${provider}`);
  return {
    provider, model: parseModel(optText(body, 'model')), clearApiKey: optBool(body, 'clearApiKey') ?? false,
    command: parseCommand(optText(body, 'command')), extraEnv: parseExtraEnv(body.extraEnv),
  };
}

export function parseLlmForm(body: Record<string, unknown>): LlmForm {
  const provider = body.provider;
  if (!isLlmProvider(provider)) throw invalid('provider must be anthropic, openai-compatible, claude-code or opencode');
  const unavailable = providerUnavailable(provider);
  if (unavailable) throw new HttpError(400, 'provider_unavailable', unavailable);
  if (isCliProvider(provider)) return parseCliForm(body, provider);
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

/** 请求日志里的参数：apiKey 只记怎么改，baseUrl 只记 origin，command 只记文件名，附加环境变量只记名字 */
function formLogFields(form: LlmForm): Record<string, unknown> {
  if (isCliProvider(form.provider)) {
    return { provider: form.provider, model: form.model, command: form.command ? path.basename(form.command) : undefined, extraEnv: form.extraEnv?.map((e) => e.name) };
  }
  return { provider: form.provider, baseUrlOrigin: form.baseUrl ? originOf(form.baseUrl) : undefined, model: form.model, apiKey: apiKeyChange(form) };
}

/** 表单里的附加环境变量换成要保存的值：没有 value 的项沿用已保存的同名值，已保存里没有时 400 */
function resolveExtraEnv(entries: ExtraEnvEntry[] | undefined, saved: Record<string, string> | undefined): Record<string, string> | undefined {
  if (entries === undefined) return saved;
  const out: Record<string, string> = {};
  for (const e of entries) {
    const value = e.value ?? saved?.[e.name];
    if (value === undefined) throw invalid(`extraEnv ${e.name} has no value and no saved value to keep`);
    out[e.name] = value;
  }
  return entries.length > 0 ? out : undefined;
}

/** CLI provider：不保存服务地址和 API key（已保存的 key 属于 API provider，不沿用），命令路径为空表示用默认查找 */
function cliUserLlm(settings: UserSettings, form: LlmForm): UserLlmSettings {
  return { provider: form.provider, model: form.model, command: form.command, extraEnv: resolveExtraEnv(form.extraEnv, settings.llm?.extraEnv) };
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
  if (isCliProvider(form.provider)) {
    const llm = cliUserLlm(settings, form);
    if (settings.llm?.apiKey !== undefined) log.info('user_settings_key_not_reused', { provider: form.provider, keySource: 'none' });
    return { llm, sources: await sourcesFor(ctx.app, ctx.repo, { ...settings, llm }) };
  }
  const saved = settings.llm?.apiKey;
  let apiKey = form.clearApiKey ? undefined : (form.apiKey ?? saved);
  const dropped = !form.apiKey && !form.clearApiKey && saved !== undefined && (await savedKeyProvider(ctx, settings)) !== form.provider;
  if (dropped) apiKey = undefined;
  // 命令路径和附加环境变量保留，切回 CLI provider 时还在
  const llm: UserLlmSettings = { provider: form.provider, baseUrl: form.baseUrl, model: form.model, apiKey, command: settings.llm?.command, extraEnv: settings.llm?.extraEnv };
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

/** URL 只留协议、主机和路径（去掉用户名密码、query、fragment）；不是带协议和主机的 URL 时返回 undefined */
function urlWithoutSecrets(value: string): string | undefined {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!url.host) return undefined;
  return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
}

type ExtraEnvItemView = { name: string; value: string; masked?: true } | { name: string; set: true };

/**
 * 附加环境变量的一项：只有代理变量和名字以 _BASE_URL 结尾的变量回传值（URL 去掉敏感部分，和原值不同时标 masked，
 * 网页不会把它当原值发回），NO_PROXY 原样回传，其余只说明已设置。
 */
function extraEnvItemView(name: string, value: string): ExtraEnvItemView {
  const upper = name.toUpperCase();
  if (upper === 'NO_PROXY') return { name, value };
  if (!PROXY_ENV.has(upper) && !upper.endsWith('_BASE_URL')) return { name, set: true };
  const shown = urlWithoutSecrets(value);
  if (shown === undefined) return { name, set: true };
  return shown === value ? { name, value } : { name, value: shown, masked: true };
}

function extraEnvView(f: LlmExtraEnvSource) {
  return { source: f.source, entries: Object.entries(f.value ?? {}).map(([name, value]) => extraEnvItemView(name, value)) };
}

/** 命令路径和实际找到的可执行文件（只在 provider 是 CLI 时查找，找不到为 null） */
function commandView(s: LlmSources, env: NodeJS.ProcessEnv) {
  const p = s.provider.value;
  const resolved = isCliProvider(p) ? resolveCliCommand(p, s.command.value, env) : undefined;
  return { ...sourceView(s.command), resolved: resolved?.ok ? resolved.path : null };
}

/** 环境变量指定的命令路径（不合法的不算），和当前生效的 provider 无关：网页切到 CLI provider 时据此提示 */
function commandEnvView(env: NodeJS.ProcessEnv): string | null {
  const v = env[LLM_ENV.command];
  return v && !commandProblem(v) ? v : null;
}

function effectiveView(s: LlmSources) {
  const unavailable = providerUnavailable(s.llm?.provider);
  const kind = s.llm ? (isCliProvider(s.llm.provider) ? 'cli' : 'api') : null;
  return { configured: s.llm !== undefined && !unavailable, kind, provider: s.llm?.provider ?? null, model: s.llm?.model ?? null, problem: unavailable ?? s.problem ?? null };
}

function llmView(s: LlmSources, env: NodeJS.ProcessEnv) {
  const baseUrl = s.baseUrl.source === 'default' ? defaultBaseUrl(s.provider.value) : s.baseUrl.value;
  return {
    llm: {
      provider: sourceView(s.provider), baseUrl: sourceView(s.baseUrl, baseUrl), model: sourceView(s.model), apiKey: apiKeyView(s.apiKey),
      command: commandView(s, env), commandEnv: commandEnvView(env), extraEnv: extraEnvView(s.extraEnv), shadowed: s.shadowed,
    },
    effective: effectiveView(s),
    unavailableProviders: unavailableProviders(),
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
  return { path: userSettingsPath(), ...llmView(sources, ctx.app.env), autoReindex: s.autoReindex ?? false };
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
  | CliTestResult
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
async function pingLlm(cfg: LlmConfig, timeoutMs: number, signal: AbortSignal): Promise<LlmTestResult> {
  let client: LlmClient;
  try {
    client = createLlmClient(cfg, { timeoutMs });
  } catch (err) {
    return { ok: false, reason: 'missing_key', message: (err as Error).message, ms: 0 };
  }
  const started = Date.now();
  try {
    await client.complete({ ...PING, signal });
  } catch (err) {
    const ms = Date.now() - started;
    if (!(err instanceof LlmTruncatedError)) return { ok: false, reason: failureReason(err, ms, timeoutMs), message: (err as Error).message.slice(0, 300), ms };
  }
  return { ok: true, provider: cfg.provider, model: cfg.model, origin: cfgOrigin(cfg), ms: Date.now() - started };
}

/** 按“保存后会生效的配置”测试：表单没填的项按用户设置、环境变量、仓库配置、默认值补齐 */
async function runLlmTest(ctx: RequestContext, form: LlmForm, signal: AbortSignal): Promise<{ result: LlmTestResult; cfg?: LlmConfig }> {
  const { sources } = await resolveUserLlm(ctx, await readUserSettings(), form);
  if (!sources.llm) return { result: { ok: false, reason: 'invalid_config', message: sources.problem ?? 'LLM is not configured', ms: 0 } };
  const cfg = sources.llm;
  if (isCliProvider(cfg.provider)) return { result: await testCliConnection({ ...cfg, provider: cfg.provider }, ctx.app.env, ctx.app.llmTest.cliTimeoutMs, signal), cfg };
  return { result: await pingLlm(cfg, ctx.app.llmTest.timeoutMs, signal), cfg };
}

/** 测试结果日志：API 记 origin，CLI 记命令文件名和版本 */
function testLogFields(form: LlmForm, cfg: LlmConfig | undefined, result: LlmTestResult): Record<string, unknown> {
  const cli = cfg !== undefined && isCliProvider(cfg.provider);
  const where = cli ? { command: 'command' in result ? path.basename(result.command) : undefined, version: 'version' in result ? result.version : undefined } : { origin: cfg ? cfgOrigin(cfg) : undefined };
  return { provider: cfg?.provider ?? form.provider, ...where, model: result.ok ? result.model : cfg?.model, ok: result.ok, reason: result.ok ? undefined : result.reason, ms: result.ms };
}

/**
 * POST /api/settings/llm/test：不写文件；同一时间只允许一个测试。
 * 浏览器断开或服务关闭时中止（本机 CLI 的子进程随之结束），不再占着测试位置。
 */
async function testLlm(ctx: RequestContext): Promise<void> {
  const form = parseLlmForm(await readJsonBody(ctx.req));
  Object.assign(ctx.logFields, formLogFields(form));
  const state = ctx.app.llmTest;
  if (state.running) throw new HttpError(409, 'test_running', 'a connection test is already running');
  const controller = new AbortController();
  const onClose = () => {
    if (!ctx.res.writableFinished) controller.abort();
  };
  ctx.res.on('close', onClose);
  Object.assign(state, { running: true, controller });
  try {
    const { result, cfg } = await runLlmTest(ctx, form, controller.signal);
    log.info('llm_test', { ...testLogFields(form, cfg, result), cancelled: controller.signal.aborted || undefined });
    Object.assign(ctx.logFields, { ok: result.ok, reason: result.ok ? undefined : result.reason });
    if (!controller.signal.aborted) sendJson(ctx.res, 200, result);
  } finally {
    ctx.res.off('close', onClose);
    Object.assign(state, { running: false, controller: undefined });
  }
}

export const settingsRoutes: Route[] = [
  { method: 'GET', pattern: '/api/settings', handler: getSettings, needsRepo: false },
  { method: 'POST', pattern: '/api/settings', handler: saveGeneral, needsRepo: false },
  { method: 'POST', pattern: '/api/settings/llm', handler: saveLlm, needsRepo: false },
  { method: 'POST', pattern: '/api/settings/llm/test', handler: testLlm, needsRepo: false },
];
