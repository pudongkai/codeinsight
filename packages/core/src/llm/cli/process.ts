import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { log } from '../../log.js';
import type { CliLlmProvider } from '../../settings/types.js';
import { cliError, firstLine } from './errors.js';
import type { CliError } from '../index.js';

/** 单行输出上限：超过时结束进程并报 bad_response */
export const MAX_LINE_CHARS = 8 * 1024 * 1024;
/** 总输出上限 */
export const MAX_OUTPUT_CHARS = 64 * 1024 * 1024;
const STDERR_TAIL_CHARS = 16 * 1024;
/** SIGTERM 后等这么久仍未退出就发 SIGKILL */
const KILL_GRACE_MS = 2_000;

/** 不传给子进程的变量：带着它们 Claude Code 会改用 API Key 计费，和“用本机登录状态”不符 */
const STRIPPED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEINSIGHT_LLM_API_KEY'];

export type CliMode = 'complete' | 'ask' | 'test' | 'session_delete';

export interface CliSpec {
  provider: CliLlmProvider;
  /** 可执行文件路径（resolveCliCommand 的结果） */
  command: string;
  args: string[];
  /** provider 固定的环境变量，优先级最高；PWD 由 runCli 设为临时目录 */
  env: Record<string, string>;
  /** 用户在设置里写的附加环境变量 */
  extraEnv?: Record<string, string>;
  stdin: string;
  /** 临时目录，同时作为 cwd 和 PWD */
  cwd: string;
  mode: CliMode;
  model?: string;
}

export interface RunCliOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  /** 两次输出之间的最长间隔，不传时只看总时长 */
  idleTimeoutMs?: number;
  /** stdout 的每一行 JSON；不是 JSON 的行不交给它，只计数 */
  onLine?: (value: unknown) => void;
  /** 子进程环境的基础，默认 process.env */
  baseEnv?: NodeJS.ProcessEnv;
}

export interface CliExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  ms: number;
  timedOut: boolean;
  aborted: boolean;
  /** 输出超过单行或总量上限 */
  outputTooLarge: boolean;
  /** 不是 JSON 的输出行数 */
  badLines: number;
  /** 启动失败（找不到命令、不可执行） */
  spawnError?: CliError;
  /** 被 killActiveCliProcesses 结束（服务或命令在关闭） */
  killed?: boolean;
}

// ---------- 临时目录 ----------

/** 建权限 700 的临时目录（真实路径，cwd 和 PWD 一致），fn 结束后（成功、失败、中止）递归删除 */
export async function withCliTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codeinsight-cli-')));
  try {
    await chmod(dir, 0o700);
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch((err: Error) => log.warn('llm_cli_tmp_cleanup_failed', { error: firstLine(err.message) }));
  }
}

/** 在临时目录里写一个只有本人可读写的文件，返回路径 */
export async function writeCliFile(dir: string, name: string, content: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, content, { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

// ---------- 环境变量 ----------

/** Claude Code 用户设置文件：$CLAUDE_CONFIG_DIR/settings.json，没设时 ~/.claude/settings.json */
export function claudeSettingsPath(env: NodeJS.ProcessEnv): string {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
}

function parseSettingsEnv(file: string, text: string): Record<string, string> {
  try {
    const env = (JSON.parse(text) as { env?: unknown } | null)?.env;
    if (typeof env !== 'object' || env === null) return {};
    return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    log.warn('llm_cli_claude_settings_invalid', { file: path.basename(file) });
    return {};
  }
}

/** 读 Claude Code 用户设置里的 env 对象（只取字符串值）；文件不存在或不是合法 JSON 时返回空对象 */
export async function readClaudeSettingsEnv(file: string): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return {};
  }
  return parseSettingsEnv(file, text);
}

/** 同步版本，创建客户端（同步）时用 */
export function readClaudeSettingsEnvSync(file: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  return parseSettingsEnv(file, text);
}

export interface CliEnv {
  env: Record<string, string>;
  /** 来自 Claude Code 用户设置 env 的变量名（只记名字） */
  settingsNames: string[];
  extraNames: string[];
}

/**
 * 子进程环境，后面的覆盖前面的：去掉 API key 的 base → Claude Code 用户设置的 env（仅 claude-code；
 * `--setting-sources ""` 下 CLI 自己不读，不补上代理和网关设置会丢）→ 附加环境变量 → provider 固定项和 PWD。
 */
export async function buildCliEnv(base: NodeJS.ProcessEnv, extraEnv: Record<string, string> | undefined, provider: CliLlmProvider, tmp: string, fixed: Record<string, string>): Promise<CliEnv> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !STRIPPED_ENV.includes(k)) env[k] = v;
  const settings = provider === 'claude-code' ? await readClaudeSettingsEnv(claudeSettingsPath({ ...base, ...extraEnv })) : {};
  Object.assign(env, settings, extraEnv ?? {}, fixed, { PWD: tmp });
  return { env, settingsNames: Object.keys(settings).sort(), extraNames: Object.keys(extraEnv ?? {}).sort() };
}

// ---------- 进程登记和结束 ----------

interface ActiveChild {
  mode: CliMode;
  /** 关闭时结束：记下 killed 后结束进程组 */
  kill: () => void;
  closed: Promise<void>;
}

/** 本进程正在运行的 CLI 子进程，退出前用 killActiveCliProcesses 结束 */
const active = new Map<ChildProcess, ActiveChild>();

function signalGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill(sig);
    else process.kill(-child.pid, sig);
  } catch {
    // 进程组已经不在了
  }
}

/** 结束子进程及它起的进程（如 MCP 服务）：POSIX 上对进程组先发 SIGTERM，2 秒后仍未退出发 SIGKILL */
function makeTerminator(child: ChildProcess, closed: () => boolean): () => void {
  let started = false;
  return () => {
    if (started) return;
    started = true;
    signalGroup(child, 'SIGTERM');
    const timer = setTimeout(() => {
      if (!closed()) signalGroup(child, 'SIGKILL');
    }, KILL_GRACE_MS);
    timer.unref();
  };
}

/** 关闭状态：none 正常；except_session_delete 只允许删 opencode 会话；all 全部不再启动 */
let shutdown: 'none' | 'except_session_delete' | 'all' = 'none';

/** 进程在关闭，这种调用不再启动 */
function blocked(mode: CliMode): boolean {
  return shutdown === 'all' || (shutdown === 'except_session_delete' && mode !== 'session_delete');
}

/**
 * 结束本进程启动的 CLI 子进程（serve 关闭、mcp 结束时调用），返回结束的个数。之后不再启动新的子进程
 * （正在准备启动的调用按中止处理），直到 resetCliShutdown。keepSessionDelete 时删 opencode 会话的命令照常运行、
 * 也不结束，用于关闭过程中先等会话删完。
 */
export async function killActiveCliProcesses(opts: { keepSessionDelete?: boolean } = {}): Promise<number> {
  shutdown = opts.keepSessionDelete && shutdown !== 'all' ? 'except_session_delete' : 'all';
  const runs = [...active.values()].filter((r) => blocked(r.mode));
  for (const r of runs) r.kill();
  await Promise.all(runs.map((r) => r.closed));
  if (runs.length > 0) log.info('llm_cli_killed', { count: runs.length, keepSessionDelete: shutdown === 'except_session_delete' });
  return runs.length;
}

/** 允许再次启动 CLI 子进程（同一进程里重新启动服务、测试时用） */
export function resetCliShutdown(): void {
  shutdown = 'none';
}

// ---------- 运行 ----------

interface RunState {
  exit: CliExit;
  pending: string;
  total: number;
  closed: boolean;
}

/** stdout 按行切开，每行解析 JSON 交给 onLine；超过上限时返回 false */
function feedStdout(state: RunState, chunk: string, onLine: RunCliOptions['onLine']): boolean {
  state.total += chunk.length;
  if (state.total > MAX_OUTPUT_CHARS) return false;
  state.pending += chunk;
  let nl: number;
  while ((nl = state.pending.indexOf('\n')) >= 0) {
    const line = state.pending.slice(0, nl).trim();
    state.pending = state.pending.slice(nl + 1);
    if (line) emitLine(state, line, onLine);
  }
  return state.pending.length <= MAX_LINE_CHARS;
}

function emitLine(state: RunState, line: string, onLine: RunCliOptions['onLine']): void {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    state.exit.badLines++;
    return;
  }
  onLine?.(value);
}

function spawnErrorOf(spec: CliSpec, err: NodeJS.ErrnoException): CliError {
  if (err.code === 'ENOENT') return cliError(spec.provider, 'command_not_found', spec.command);
  if (err.code === 'EACCES') return cliError(spec.provider, 'not_executable', spec.command);
  return cliError(spec.provider, 'cli_failed', firstLine(err.message));
}

function newState(): RunState {
  return { exit: { exitCode: null, signal: null, stderrTail: '', ms: 0, timedOut: false, aborted: false, outputTooLarge: false, badLines: 0 }, pending: '', total: 0, closed: false };
}

/** 启动子进程并等它结束；超时、中止、输出过大时结束进程组。不抛错，结果和原因都在返回值里 */
function runChild(spec: CliSpec, env: Record<string, string>, opts: RunCliOptions): Promise<CliExit> {
  const started = Date.now();
  const state = newState();
  const { exit } = state;
  return new Promise((resolve) => {
    // 准备环境和临时目录期间可能已被中止或进入关闭：不再启动
    if (blocked(spec.mode) || opts.signal?.aborted) {
      log.info('llm_cli_not_started', { provider: spec.provider, mode: spec.mode, reason: blocked(spec.mode) ? 'shutting_down' : 'aborted' });
      resolve({ ...exit, aborted: true });
      return;
    }
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: process.platform !== 'win32' });
    const terminate = makeTerminator(child, () => state.closed);
    let resolveClosed!: () => void;
    const kill = (): void => {
      exit.killed = true;
      terminate();
    };
    active.set(child, { mode: spec.mode, kill, closed: new Promise((r) => (resolveClosed = r)) });
    const timers = watchTimers(opts, terminate, exit);
    const onAbort = (): void => {
      exit.aborted = true;
      terminate();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
    const finish = (): void => {
      if (state.closed) return;
      state.closed = true;
      timers.clear();
      opts.signal?.removeEventListener('abort', onAbort);
      active.delete(child);
      if (state.pending.trim()) emitLine(state, state.pending.trim(), opts.onLine);
      exit.ms = Date.now() - started;
      resolveClosed();
      resolve(exit);
    };
    watchOutput(child, state, { onLine: opts.onLine, touch: timers.touch, terminate });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (child.pid !== undefined) return;
      exit.spawnError = spawnErrorOf(spec, err);
      finish();
    });
    child.on('exit', () => afterExit(child, state, terminate));
    child.on('close', (code, sig) => {
      exit.exitCode = code;
      exit.signal = sig;
      finish();
    });
    child.stdin!.on('error', () => undefined);
    child.stdin!.end(spec.stdin);
  });
}

/** stdout 按行交给 onLine，stderr 只留末尾；有输出就重置空闲计时，输出过大时结束进程 */
function watchOutput(child: ChildProcess, state: RunState, h: { onLine: RunCliOptions['onLine']; touch: () => void; terminate: () => void }): void {
  const { exit } = state;
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    h.touch();
    if (!exit.outputTooLarge && !feedStdout(state, chunk, h.onLine)) {
      exit.outputTooLarge = true;
      state.pending = '';
      h.terminate();
    }
  });
  child.stderr!.on('data', (chunk: string) => {
    h.touch();
    exit.stderrTail = (exit.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
  });
}

/** 主进程退出后它起的进程还占着输出管道时，close 不会到来：等一会儿仍未关闭就结束整个进程组 */
function afterExit(child: ChildProcess, state: RunState, terminate: () => void): void {
  const timer = setTimeout(() => {
    if (state.closed) return;
    terminate();
    signalGroup(child, 'SIGKILL');
    child.stdout?.destroy();
    child.stderr?.destroy();
  }, KILL_GRACE_MS);
  timer.unref();
}

interface Timers {
  touch: () => void;
  clear: () => void;
}

function watchTimers(opts: RunCliOptions, terminate: () => void, exit: CliExit): Timers {
  const fire = (): void => {
    exit.timedOut = true;
    terminate();
  };
  const total = setTimeout(fire, opts.timeoutMs);
  let idle = opts.idleTimeoutMs ? setTimeout(fire, opts.idleTimeoutMs) : undefined;
  return {
    touch: () => {
      if (!idle) return;
      clearTimeout(idle);
      idle = setTimeout(fire, opts.idleTimeoutMs);
    },
    clear: () => {
      clearTimeout(total);
      if (idle) clearTimeout(idle);
    },
  };
}

/** 参数里只记选项名，不记值（值里有临时文件路径、JSON Schema、模型名） */
function optionNames(args: string[]): string[] {
  return args.filter((a) => a.startsWith('-')).map((a) => a.split('=')[0]!);
}

/**
 * 运行一次 CLI：stdin 写入 prompt 后关闭，stdout 每行 JSON 交给 onLine。
 * 日志只记命令名、选项名、模型、超时、prompt 字符数和环境变量名，不记 prompt 和变量值。
 */
export async function runCli(spec: CliSpec, opts: RunCliOptions): Promise<CliExit> {
  if (blocked(spec.mode) || opts.signal?.aborted) return { ...newState().exit, aborted: true };
  const { env, settingsNames, extraNames } = await buildCliEnv(opts.baseEnv ?? process.env, spec.extraEnv, spec.provider, spec.cwd, spec.env);
  log.info('llm_cli_start', {
    provider: spec.provider, model: spec.model || 'default', mode: spec.mode, command: path.basename(spec.command), options: optionNames(spec.args),
    promptChars: spec.stdin.length, timeoutMs: opts.timeoutMs, idleTimeoutMs: opts.idleTimeoutMs, settingsEnv: settingsNames, extraEnv: extraNames,
  });
  return runChild(spec, env, opts);
}

export interface CliUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  numTurns?: number;
}

export function logCliExit(spec: Pick<CliSpec, 'provider' | 'mode'>, exit: CliExit, usage: CliUsage = {}): void {
  log.info('llm_cli_exit', { provider: spec.provider, mode: spec.mode, ms: exit.ms, exitCode: exit.exitCode, signal: exit.signal, ...usage });
}

export function logCliFailure(spec: Pick<CliSpec, 'provider' | 'mode'>, err: CliError, exit: CliExit): void {
  log.warn('llm_cli_failed', { provider: spec.provider, mode: spec.mode, kind: err.kind, exitCode: exit.exitCode, stderr: firstLine(exit.stderrTail) || undefined });
}
