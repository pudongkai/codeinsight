import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from '../../log.js';
import { LlmTruncatedError, type CliError, type LlmClient, type LlmRequest } from '../index.js';
import type { CliClientOptions } from './claude-code.js';
import { cliError, firstLine, kindOfStatus, runErrorOf } from './errors.js';
import { logCliExit, logCliFailure, runCli, withCliTempDir, writeCliFile, type CliExit, type CliSpec, type CliUsage } from './process.js';
import { flattenMessages } from './prompt.js';

/**
 * 权限隔离（全部工具拒绝，只放行 codeinsight 的 MCP 工具）是否已在真实 opencode 的工具调用中确认生效。
 * 为 false 时 opencode 不可选：opencode 默认放行多数工具，权限没生效时可能在用户机器上执行命令。
 */
export const OPENCODE_PERMISSIONS_VERIFIED = false;
export const OPENCODE_AGENT = 'codeinsight';
/** 结构化输出调用的最多步数 */
export const OPENCODE_COMPLETE_STEPS = 3;
const SESSION_DELETE_TIMEOUT_MS = 10_000;
const DEFAULT_FLUSH_MS = 5_000;

export interface OpencodeConfigOptions {
  /** 系统提示文件；不传时不定义 agent（删除会话时用） */
  systemFile?: string;
  steps?: number;
  /** codeinsight 问答工具的 MCP 服务启动命令 */
  mcpCommand?: string[];
  /** 用户全局配置里的 MCP 服务名，逐个关掉 */
  disabledMcp?: string[];
}

/**
 * 通过 OPENCODE_CONFIG_CONTENT 合并在用户全局配置之后：全局权限全部拒绝，codeinsight agent 也全部拒绝，
 * 只放行 codeinsight 的 MCP 工具；用户全局配置里的 MCP 服务逐个关掉。只写 enabled 的条目会被 opencode 丢弃，
 * 所以关掉时写完整条目。用户的 provider、模型和登录不受影响。
 */
export function opencodeConfig(o: OpencodeConfigOptions): Record<string, unknown> {
  const mcp: Record<string, unknown> = {};
  for (const name of o.disabledMcp ?? []) if (name !== OPENCODE_AGENT) mcp[name] = { type: 'local', command: ['false'], enabled: false };
  if (o.mcpCommand) mcp[OPENCODE_AGENT] = { type: 'local', command: o.mcpCommand, enabled: true };
  const config: Record<string, unknown> = { permission: { '*': 'deny' } };
  if (o.systemFile) {
    const permission = o.mcpCommand ? { '*': 'deny', [`${OPENCODE_AGENT}_*`]: 'allow' } : { '*': 'deny' };
    config.agent = { [OPENCODE_AGENT]: { mode: 'primary', prompt: `{file:${o.systemFile}}`, steps: o.steps ?? OPENCODE_COMPLETE_STEPS, permission } };
  }
  if (Object.keys(mcp).length > 0) config.mcp = mcp;
  return config;
}

/** 固定环境变量：内联配置、不读项目配置和 Claude Code 的 CLAUDE.md / skills、不自动升级 */
export function opencodeEnv(config: Record<string, unknown>): Record<string, string> {
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
  };
}

export function opencodeArgs(model?: string): string[] {
  return ['run', '--standalone', '--format', 'json', '--agent', OPENCODE_AGENT, '--title', 'codeinsight', ...(model ? [`--model=${model}`] : [])];
}

// ---------- 用户全局配置里的 MCP 服务名 ----------

/** 去掉 JSONC 的注释和结尾多余的逗号（字符串里的内容不动） */
export function stripJsonc(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end - 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
  return Math.min(i + 1, text.length);
}

/** mcp 下的服务名：旧格式直接是名字，2.x 格式在 servers 下 */
function mcpNames(config: unknown): string[] {
  const mcp = (config as { mcp?: unknown } | null)?.mcp;
  if (typeof mcp !== 'object' || mcp === null) return [];
  const names: string[] = [];
  for (const [k, v] of Object.entries(mcp)) {
    if (k === 'servers' && typeof v === 'object' && v !== null) names.push(...Object.keys(v));
    else if (k !== 'timeout') names.push(k);
  }
  return names;
}

/** 用户全局配置文件（$XDG_CONFIG_HOME/opencode 或 ~/.config/opencode）和 OPENCODE_CONFIG 指向的文件 */
export function opencodeGlobalConfigFiles(env: NodeJS.ProcessEnv): string[] {
  const dir = path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
  const files = ['opencode.json', 'opencode.jsonc', 'config.json'].map((f) => path.join(dir, f));
  return env.OPENCODE_CONFIG ? [...files, env.OPENCODE_CONFIG] : files;
}

/** 读用户全局配置里的 MCP 服务名；读不了或解析失败的文件记日志后跳过 */
export function opencodeGlobalMcpNames(env: NodeJS.ProcessEnv): string[] {
  const names = new Set<string>();
  for (const file of opencodeGlobalConfigFiles(env)) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('opencode_global_config_unreadable', { file: path.basename(file), error: firstLine((err as Error).message) });
      continue;
    }
    try {
      for (const n of mcpNames(JSON.parse(stripJsonc(text)))) names.add(n);
    } catch {
      log.warn('opencode_global_config_unreadable', { file: path.basename(file), error: 'invalid JSON' });
    }
  }
  return [...names].sort();
}

// ---------- 输出解析和错误分类 ----------

export interface OpencodeErrorInfo {
  name?: string;
  type?: string;
  message?: string;
  status?: number;
  statusCode?: number;
  isRetryable?: boolean;
  data?: { message?: string; statusCode?: number; isRetryable?: boolean };
}

export interface OpencodeOutput {
  sessionId?: string;
  text: string[];
  error?: OpencodeErrorInfo;
  /** 最后一个 step_finish 的 reason */
  lastReason?: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number; steps: number };
}

export function newOpencodeOutput(): OpencodeOutput {
  return { text: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 } };
}

interface OpencodeLine {
  type?: unknown;
  sessionID?: unknown;
  part?: { text?: unknown; reason?: unknown; cost?: unknown; tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } } };
  error?: unknown;
}

function addStepUsage(out: OpencodeOutput, part: NonNullable<OpencodeLine['part']>): void {
  const t = part.tokens;
  out.usage.steps++;
  out.usage.inputTokens += (t?.input ?? 0) + (t?.cache?.read ?? 0) + (t?.cache?.write ?? 0);
  out.usage.outputTokens += t?.output ?? 0;
  if (typeof part.cost === 'number') out.usage.costUsd += part.cost;
  if (typeof part.reason === 'string') out.lastReason = part.reason;
}

/** 收一行 `--format json` 输出；只依赖 type、sessionID、part.text、part.tokens、error，未知类型的行忽略 */
export function parseOpencodeLine(out: OpencodeOutput, value: unknown): void {
  const line = value as OpencodeLine | null;
  if (typeof line?.sessionID === 'string') out.sessionId ??= line.sessionID;
  if (line?.type === 'text' && typeof line.part?.text === 'string') out.text.push(line.part.text);
  else if (line?.type === 'step_finish' && line.part) addStepUsage(out, line.part);
  else if (line?.type === 'error') out.error = (typeof line.error === 'object' && line.error !== null ? line.error : { message: String(line.error) }) as OpencodeErrorInfo;
}

/** 1.x 的错误按 name 区分、状态在 data.statusCode；2.x 按 type（如 provider.auth）区分、状态在 status */
function errorKind(e: OpencodeErrorInfo): CliError['kind'] | 'truncated' {
  const id = e.name ?? e.type ?? '';
  const status = e.data?.statusCode ?? e.statusCode ?? e.status;
  if (id === 'ProviderAuthError' || id === 'provider.auth') return 'not_logged_in';
  if (id === 'MessageOutputLengthError' || /output.?length/i.test(id)) return 'truncated';
  if (id === 'ContextOverflowError' || /context.?overflow/i.test(id)) return 'context_overflow';
  if (id === 'ContentFilterError' || /content.?filter/i.test(id)) return 'content_filtered';
  if (id === 'StructuredOutputError') return 'bad_response';
  if (/free.?limit|quota/i.test(id)) return 'quota';
  const byStatus = kindOfStatus(status);
  if (byStatus) return byStatus;
  return (e.data?.isRetryable ?? e.isRetryable) ? 'server_error' : 'cli_failed';
}

/** 按先后顺序：运行问题 → error 行 → 步骤因长度结束 → 退出码非 0 → 没有文字。成功时返回 undefined */
export function classifyOpencodeError(out: OpencodeOutput, exit: CliExit, maxTokens = 0): CliError | LlmTruncatedError | undefined {
  const run = runErrorOf('opencode', exit);
  if (run) return run;
  if (out.error) {
    const kind = errorKind(out.error);
    if (kind === 'truncated') return new LlmTruncatedError(maxTokens);
    return cliError('opencode', kind, firstLine(out.error.data?.message ?? out.error.message));
  }
  if (out.lastReason === 'length') return new LlmTruncatedError(maxTokens);
  if (exit.exitCode !== 0) return cliError('opencode', 'cli_failed', firstLine(exit.stderrTail) || `exit code ${exit.exitCode ?? exit.signal}`);
  if (out.text.join('').trim() === '') return cliError('opencode', 'bad_response', 'no text in the output');
  return undefined;
}

export function opencodeUsage(out: OpencodeOutput): CliUsage {
  const u = out.usage;
  return u.steps > 0 ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.costUsd, numTurns: u.steps } : {};
}

// ---------- 会话清理 ----------

interface DeleteJob {
  sessionId: string;
  command: string;
  extraEnv?: Record<string, string>;
  baseEnv: NodeJS.ProcessEnv;
  disabledMcp: string[];
}

async function deleteSession(job: DeleteJob): Promise<void> {
  const exit = await withCliTempDir((dir) => runCli({
    provider: 'opencode', command: job.command, mode: 'session_delete', cwd: dir, extraEnv: job.extraEnv, stdin: '',
    args: ['session', 'delete', job.sessionId, '--standalone'], env: opencodeEnv(opencodeConfig({ disabledMcp: job.disabledMcp })),
  }, { timeoutMs: SESSION_DELETE_TIMEOUT_MS, baseEnv: job.baseEnv }));
  if (exit.spawnError || exit.timedOut || exit.exitCode !== 0) {
    log.warn('llm_cli_session_delete_failed', { provider: 'opencode', exitCode: exit.exitCode, timedOut: exit.timedOut, stderr: firstLine(exit.stderrTail) || undefined });
  }
}

/** opencode 每次 run 都保存会话：结束后放进队列，后台一次删一个，不阻塞调用结果 */
export class OpencodeSessionCleaner {
  private readonly queue: DeleteJob[] = [];
  private running?: Promise<void>;
  private inFlight = 0;

  enqueue(job: DeleteJob): void {
    this.queue.push(job);
    this.start();
  }

  get pending(): number {
    return this.queue.length + this.inFlight;
  }

  private start(): void {
    if (this.running) return;
    this.running = this.drain().finally(() => {
      this.running = undefined;
      if (this.queue.length > 0) this.start();
    });
  }

  private async drain(): Promise<void> {
    for (let job = this.queue.shift(); job; job = this.queue.shift()) {
      this.inFlight = 1;
      await deleteSession(job).catch((err: Error) => log.warn('llm_cli_session_delete_failed', { provider: 'opencode', error: firstLine(err.message) }));
      this.inFlight = 0;
    }
  }

  /** 等队列清空，最多等 timeoutMs；返回没删完的个数 */
  async flush(timeoutMs = DEFAULT_FLUSH_MS): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.running && Date.now() < deadline) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.running, new Promise((r) => (timer = setTimeout(r, deadline - Date.now())))]);
      clearTimeout(timer);
    }
    const left = this.pending;
    if (left > 0) log.warn('opencode_sessions_left', { count: left });
    return left;
  }
}

export const opencodeSessions = new OpencodeSessionCleaner();

export interface OpencodeRunContext {
  baseEnv: NodeJS.ProcessEnv;
  /** 用户全局配置里的 MCP 服务名，运行和删会话时都要关掉 */
  disabledMcp: string[];
  /** 运行结束后调用：有会话 ID 时加入删除队列 */
  deleteSessionLater: (sessionId: string | undefined) => void;
}

/** 一次 opencode 运行的准备：读全局 MCP 名单，并提供结束后删会话的入口 */
export function opencodeRunContext(o: Pick<CliClientOptions, 'command' | 'extraEnv' | 'baseEnv'>): OpencodeRunContext {
  const baseEnv = o.baseEnv ?? process.env;
  const disabledMcp = opencodeGlobalMcpNames({ ...baseEnv, ...o.extraEnv });
  return {
    baseEnv, disabledMcp,
    deleteSessionLater: (sessionId) => {
      if (sessionId) opencodeSessions.enqueue({ sessionId, command: o.command, extraEnv: o.extraEnv, baseEnv, disabledMcp });
    },
  };
}

/** serve 关闭、overview / ask / review 命令结束前调用，等会话删除队列清空（最多 timeoutMs） */
export function flushOpencodeSessions(timeoutMs = DEFAULT_FLUSH_MS): Promise<number> {
  return opencodeSessions.flush(timeoutMs);
}

// ---------- 客户端 ----------

/** 用本机 opencode（`opencode run`）完成一次请求，用它自己配置的 provider 和登录 */
export class OpencodeClient implements LlmClient {
  readonly provider = 'opencode';
  readonly model: string;
  readonly baseUrl = undefined;
  readonly envModel?: string;
  constructor(readonly opts: CliClientOptions) {
    this.model = opts.model;
    this.envModel = opts.envModel;
  }

  complete(req: LlmRequest): Promise<string> {
    const { baseEnv, disabledMcp, deleteSessionLater } = opencodeRunContext(this.opts);
    return withCliTempDir(async (dir) => {
      const systemFile = await writeCliFile(dir, 'system.md', req.system);
      const spec: CliSpec = {
        provider: 'opencode', command: this.opts.command, mode: 'complete', model: this.model, cwd: dir, extraEnv: this.opts.extraEnv,
        args: opencodeArgs(this.model), env: opencodeEnv(opencodeConfig({ systemFile, disabledMcp })), stdin: flattenMessages(req.messages),
      };
      const out = newOpencodeOutput();
      const exit = await runCli(spec, { signal: req.signal, timeoutMs: this.opts.timeoutMs, idleTimeoutMs: this.opts.idleTimeoutMs, baseEnv, onLine: (v) => parseOpencodeLine(out, v) });
      logCliExit(spec, exit, opencodeUsage(out));
      deleteSessionLater(out.sessionId);
      const err = classifyOpencodeError(out, exit, req.maxTokens);
      if (err) {
        if (!(err instanceof LlmTruncatedError)) logCliFailure(spec, err, exit);
        throw err;
      }
      return out.text.join('');
    });
  }
}
