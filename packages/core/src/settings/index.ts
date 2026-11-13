import { chmod, mkdir, readFile, realpath, rename, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { log } from '../log.js';
import { writeFileAtomic } from '../util/atomic-file.js';
import { isLlmProvider, type RecentRepo, type UserLlmSettings, type UserSettings, type UserSettingsOptions } from './types.js';
import { commandProblem, envNameProblem, envValueProblem, MAX_EXTRA_ENV_ENTRIES, modelProblem } from './validate.js';

export * from './types.js';
export * from './validate.js';

export const USER_SETTINGS_VERSION = 1;
export const MAX_RECENT_REPOS = 10;
const SETTINGS_FILE = 'settings.json';
/** Windows 的文件权限不是 POSIX 模式位，不检查 */
const CHECK_PERMISSIONS = process.platform !== 'win32';

/** 用户级目录：CODEINSIGHT_HOME，没设时 ~/.codeinsight。只看进程环境变量，设置文件位置是进程级的 */
export function codeinsightHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEINSIGHT_HOME?.trim();
  return home ? path.resolve(home) : defaultHome();
}

const defaultHome = (): string => path.join(os.homedir(), '.codeinsight');

export function userSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(codeinsightHome(env), SETTINGS_FILE);
}

const emptySettings = (): UserSettings => ({ recentRepos: [] });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function ignored(key: string, reason: string): void {
  log.warn('user_settings_value_ignored', { key, reason });
}

const LLM_STRING_KEYS = ['baseUrl', 'model', 'apiKey', 'command'] as const;

/** 各字符串项的校验；没列出的只要求非空字符串 */
const LLM_STRING_CHECKS: Partial<Record<(typeof LLM_STRING_KEYS)[number], (v: unknown) => string | undefined>> = {
  model: modelProblem,
  command: (v) => commandProblem(v),
};

const nonEmptyString = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? undefined : 'expected a non-empty string');

/** 不合格的名字可能是任意文本，只在它像变量名时写进日志 */
const ENV_NAME_LOG = /^[\w.-]{1,64}$/;

/** 不合格的变量逐个忽略，超过上限的只保留前面的；日志只记变量名，不记值 */
function normalizeExtraEnv(raw: unknown): Record<string, string> | undefined {
  if (!isObject(raw)) {
    ignored('llm.extraEnv', 'expected an object');
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const problem = envNameProblem(name) ?? envValueProblem(value);
    if (problem) ignored(`llm.extraEnv.${ENV_NAME_LOG.test(name) ? name : '?'}`, problem);
    else if (Object.keys(out).length >= MAX_EXTRA_ENV_ENTRIES) ignored(`llm.extraEnv.${name}`, `expected at most ${MAX_EXTRA_ENV_ENTRIES} entries`);
    else out[name] = value as string;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 单项格式不对时只忽略这一项；日志只记键名，不记值（可能是 API key） */
function normalizeLlm(raw: unknown): UserLlmSettings | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    ignored('llm', 'expected an object');
    return undefined;
  }
  const out: UserLlmSettings = {};
  if (raw.provider !== undefined) {
    if (isLlmProvider(raw.provider)) out.provider = raw.provider;
    else ignored('llm.provider', 'expected anthropic, openai-compatible, claude-code or opencode');
  }
  for (const key of LLM_STRING_KEYS) {
    const v = raw[key];
    if (v === undefined) continue;
    const problem = (LLM_STRING_CHECKS[key] ?? nonEmptyString)(v);
    if (problem) ignored(`llm.${key}`, problem);
    else out[key] = v as string;
  }
  if (raw.extraEnv !== undefined) {
    const extraEnv = normalizeExtraEnv(raw.extraEnv);
    if (extraEnv) out.extraEnv = extraEnv;
  }
  return out;
}

/** 去重（同一路径保留最新的）、从新到旧排序、最多 MAX_RECENT_REPOS 个 */
function tidyRecent(list: RecentRepo[]): RecentRepo[] {
  const seen = new Set<string>();
  return [...list]
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .filter((r) => !seen.has(r.path) && seen.add(r.path))
    .slice(0, MAX_RECENT_REPOS);
}

function normalizeRecent(raw: unknown): RecentRepo[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    ignored('recentRepos', 'expected an array');
    return [];
  }
  const ok = raw.filter((r): r is RecentRepo =>
    isObject(r) && typeof r.path === 'string' && path.isAbsolute(r.path) && typeof r.lastOpenedAt === 'number' && Number.isFinite(r.lastOpenedAt));
  if (ok.length < raw.length) ignored('recentRepos', 'expected items with an absolute path and a numeric lastOpenedAt');
  return tidyRecent(ok.map((r) => ({ path: r.path, lastOpenedAt: r.lastOpenedAt })));
}

function normalizeSettings(raw: Record<string, unknown>): UserSettings {
  const out: UserSettings = { recentRepos: normalizeRecent(raw.recentRepos) };
  const llm = normalizeLlm(raw.llm);
  if (llm) out.llm = llm;
  if (raw.autoReindex !== undefined) {
    if (typeof raw.autoReindex === 'boolean') out.autoReindex = raw.autoReindex;
    else ignored('autoReindex', 'expected a boolean');
  }
  return out;
}

/** JSON 解析错误只记类型和位置：V8 的错误文字会带出附近的原文，可能含 API key */
function jsonErrorReason(err: unknown): string {
  const msg = (err as Error).message ?? '';
  const pos = /position (\d+)/.exec(msg)?.[1];
  const lineCol = /line (\d+) column (\d+)/.exec(msg);
  const where = lineCol ? ` at line ${lineCol[1]} column ${lineCol[2]}` : pos ? ` at position ${pos}` : '';
  return `invalid JSON (${(err as Error).name ?? 'Error'})${where}`;
}

/** 整个文件不能用时返回原因：JSON 解析失败、顶层不是对象、version 不认识（没写 version 按 1） */
function parseSettings(text: string): { value: Record<string, unknown> } | { reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { reason: jsonErrorReason(err) };
  }
  if (!isObject(value)) return { reason: 'expected a JSON object' };
  if (value.version !== undefined && value.version !== USER_SETTINGS_VERSION) return { reason: `unknown version ${JSON.stringify(value.version)}` };
  return { value };
}

/** 权限比 want 宽（组或其他用户有任何权限位）时改成 want；改不了只记日志 */
async function tightenMode(target: string, want: number, event: string): Promise<void> {
  if (!CHECK_PERMISSIONS) return;
  try {
    const mode = (await stat(target)).mode & 0o777;
    if ((mode & 0o077) === 0) return;
    log.warn(event, { path: target, mode: mode.toString(8) });
    await chmod(target, want);
  } catch (err) {
    log.warn('user_settings_chmod_failed', { path: target, error: (err as Error).message });
  }
}

const fixPermissions = (file: string) => tightenMode(file, 0o600, 'user_settings_permissions');

interface FileState {
  settings: UserSettings;
  /** 文件存在但整个不能用，下次写入前要先改名保留 */
  broken: boolean;
}

/** 文件不存在按空设置；其他读取错误（权限不足等）抛出，由调用方决定 */
async function readSettingsFile(file: string): Promise<FileState> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { settings: emptySettings(), broken: false };
    throw err;
  }
  await fixPermissions(file);
  const parsed = parseSettings(text);
  if ('reason' in parsed) {
    log.warn('user_settings_invalid', { path: file, reason: parsed.reason });
    return { settings: emptySettings(), broken: true };
  }
  return { settings: normalizeSettings(parsed.value), broken: false };
}

export async function readUserSettings(opts: UserSettingsOptions = {}): Promise<UserSettings> {
  return (await readSettingsFile(opts.path ?? userSettingsPath())).settings;
}

function serialize(s: UserSettings): string {
  const out: Record<string, unknown> = { version: USER_SETTINGS_VERSION };
  const llm = Object.fromEntries(Object.entries(s.llm ?? {}).filter(([, v]) => v !== undefined));
  if (Object.keys(llm).length > 0) out.llm = llm;
  if (s.autoReindex !== undefined) out.autoReindex = s.autoReindex;
  out.recentRepos = tidyRecent(s.recentRepos);
  return JSON.stringify(out, null, 2) + '\n';
}

/** 不能用的旧文件改名保留，不直接覆盖，用户还能找回里面的内容；另一个进程已经改名时（ENOENT）照常继续 */
async function setAsideBroken(file: string): Promise<void> {
  const to = `${file}.broken-${Date.now()}`;
  try {
    await rename(file, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  log.warn('user_settings_broken_renamed', { path: file, to });
}

/** 实际要写的文件：设置文件是符号链接时写到链接目标，保留链接；文件或目标不存在时就是它本身 */
async function writeTarget(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return file;
    throw err;
  }
}

/**
 * 设置目录不存在时按 700 新建。已存在的目录只在它是默认的 ~/.codeinsight 时收紧到 700：
 * CODEINSIGHT_HOME 可能指向用户主目录或共享目录，不能改它原有的权限。
 */
async function ensureHomeDir(dir: string): Promise<void> {
  const created = await mkdir(dir, { recursive: true, mode: 0o700 });
  if (created !== undefined || path.resolve(dir) === defaultHome()) await tightenMode(dir, 0o700, 'user_settings_dir_permissions');
}

/** 两份设置之间变了的字段名（llm 下按子键列出），写日志用，不含值 */
function changedFields(prev: UserSettings, next: UserSettings): string[] {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const out: string[] = [];
  const llmKeys = new Set([...Object.keys(prev.llm ?? {}), ...Object.keys(next.llm ?? {})]) as Set<keyof UserLlmSettings>;
  for (const k of llmKeys) if (!same(prev.llm?.[k], next.llm?.[k])) out.push(`llm.${k}`);
  if (prev.autoReindex !== next.autoReindex) out.push('autoReindex');
  if (!same(prev.recentRepos, next.recentRepos)) out.push('recentRepos');
  return out;
}

/**
 * 读最新内容 → change → 原子写回（文件 600，新建的目录 700）。每次写前重新读文件，
 * 缩小多个进程同时修改时互相覆盖的范围。
 */
export async function updateUserSettings(change: (s: UserSettings) => UserSettings, opts: UserSettingsOptions = {}): Promise<UserSettings> {
  const file = opts.path ?? userSettingsPath();
  await ensureHomeDir(path.dirname(file));
  const target = await writeTarget(file);
  const current = await readSettingsFile(target);
  if (current.broken) await setAsideBroken(target);
  const next = change(current.settings);
  const tidy = { ...next, recentRepos: tidyRecent(next.recentRepos) };
  await writeFileAtomic(target, serialize(tidy), { mode: 0o600 });
  log.info('user_settings_written', { path: target, fields: changedFields(current.settings, tidy).join(',') });
  return tidy;
}

/** 路径的真实路径（跟随符号链接）；不存在时返回解析后的绝对路径。比较两个路径是否指同一处时用 */
export async function realPathOr(p: string): Promise<string> {
  const abs = path.resolve(p);
  return realpath(abs).catch(() => abs);
}

/** 放到最近列表最前，超过 MAX_RECENT_REPOS 个丢掉最旧的 */
export async function touchRecentRepo(repo: string, opts: UserSettingsOptions = {}): Promise<void> {
  const real = await realPathOr(repo);
  await updateUserSettings((s) => ({
    ...s,
    recentRepos: [{ path: real, lastOpenedAt: Date.now() }, ...s.recentRepos.filter((r) => r.path !== real)],
  }), opts);
  log.info('recent_repo_touched', { repo: real });
}

/** 从最近列表移除；不在列表里时不写文件 */
export async function removeRecentRepo(repo: string, opts: UserSettingsOptions = {}): Promise<void> {
  const targets = new Set([path.resolve(repo), await realPathOr(repo)]);
  const current = await readUserSettings(opts);
  if (!current.recentRepos.some((r) => targets.has(r.path))) return;
  await updateUserSettings((s) => ({ ...s, recentRepos: s.recentRepos.filter((r) => !targets.has(r.path)) }), opts);
  log.info('recent_repo_removed', { repo: path.resolve(repo) });
}
