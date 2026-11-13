import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {
  buildCliEnv, claudeSettingsPath, CliError, createCliClient, LlmTruncatedError, resolveCliCommand, withCliTempDir,
} from '@codeinsight/core';
import type { CliLlmProvider, LlmConfig } from '@codeinsight/core';

/** 版本和登录检查的超时 */
const PRECHECK_TIMEOUT_MS = 10_000;
const MESSAGE_CHARS = 300;
const PROBE = { system: '', messages: [{ role: 'user' as const, content: 'Reply with OK.' }], maxTokens: 16 };

/** 有这些变量时 Claude Code 不需要登录也能调用，登录检查不作为失败 */
const KEY_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

export type CliTestResult =
  | { ok: true; provider: CliLlmProvider; model: string; command: string; version: string; ms: number }
  | { ok: false; reason: string; message: string; ms: number };

type CliConfig = LlmConfig & { provider: CliLlmProvider };

interface ShortRun {
  ok: boolean;
  stdout: string;
  /** 失败时的第一行错误信息 */
  error: string;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]!.slice(0, MESSAGE_CHARS);
}

/** 运行一次很快结束的子命令（--version、auth status），超时后结束；不经过 shell */
function runShort(command: string, args: string[], env: Record<string, string>, cwd: string, signal: AbortSignal): Promise<ShortRun> {
  return new Promise((resolve) => {
    const opts = { env, cwd, signal, timeout: PRECHECK_TIMEOUT_MS, killSignal: 'SIGKILL' as const, maxBuffer: 1024 * 1024, windowsHide: true };
    const child = execFile(command, args, opts, (err, stdout, stderr) => {
      const error = err ? firstLine(String(stderr)) || firstLine(err.message) : '';
      resolve({ ok: !err, stdout: String(stdout), error });
    });
    // 没有输入：关掉 stdin，读 stdin 的程序不会一直等
    child.stdin?.end();
  });
}

/** Claude Code 用户设置里是否配置了 apiKeyHelper（CodeInsight 不执行它） */
async function hasApiKeyHelper(env: Record<string, string>): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(claudeSettingsPath(env), 'utf8')) as { apiKeyHelper?: unknown } | null;
    return typeof parsed?.apiKeyHelper === 'string' && parsed.apiKeyHelper !== '';
  } catch {
    return false;
  }
}

/** `claude auth status --json` 明确说未登录且没有 key 时返回提示；输出看不懂时不算失败，交给后面的实际调用 */
async function claudeLoginProblem(command: string, env: Record<string, string>, cwd: string, signal: AbortSignal): Promise<string | undefined> {
  const run = await runShort(command, ['auth', 'status', '--json'], env, cwd, signal);
  let loggedIn: unknown;
  try {
    loggedIn = (JSON.parse(run.stdout) as { loggedIn?: unknown } | null)?.loggedIn;
  } catch {
    return undefined;
  }
  if (loggedIn !== false || KEY_ENV.some((k) => env[k])) return undefined;
  if (await hasApiKeyHelper(env)) {
    return 'apiKeyHelper detected: CodeInsight does not run it; run `claude` in a terminal to log in, or add ANTHROPIC_API_KEY to the extra environment variables';
  }
  return 'Not logged in; run `claude` in a terminal to log in';
}

type Precheck = { ok: true; version: string } | { ok: false; reason: string; message: string };

/** 版本检查和（Claude Code 的）登录检查，用和正式调用相同的环境变量，在临时目录里运行 */
async function precheck(cfg: CliConfig, command: string, base: NodeJS.ProcessEnv, signal: AbortSignal): Promise<Precheck> {
  return withCliTempDir(async (dir) => {
    const { env } = await buildCliEnv(base, cfg.extraEnv, cfg.provider, dir, {});
    const version = await runShort(command, ['--version'], env, dir, signal);
    if (signal.aborted) return { ok: false, reason: 'cancelled', message: 'the test was cancelled' };
    if (!version.ok) return { ok: false, reason: 'version_failed', message: version.error || '--version failed' };
    const login = cfg.provider === 'claude-code' ? await claudeLoginProblem(command, env, dir, signal) : undefined;
    if (signal.aborted) return { ok: false, reason: 'cancelled', message: 'the test was cancelled' };
    if (login) return { ok: false, reason: 'not_logged_in', message: login };
    return { ok: true, version: firstLine(version.stdout) };
  });
}

/** 实际调用失败的原因：CliError 用它的分类，其他错误按回复格式不对 */
function probeFailure(err: unknown): { reason: string; message: string } {
  const message = firstLine((err as Error).message ?? String(err));
  return { reason: err instanceof CliError ? err.kind : 'bad_response', message };
}

/**
 * 测试本机 CLI：找命令 → `--version` → Claude Code 查登录状态（未登录时不发模型请求）→ 用正式客户端发一次最小请求。
 * 收到回复（包括被截断）就算成功；模型取配置值或环境变量决定的模型，都没有时为空串（工具默认模型）。
 * signal 中止时结束正在运行的子进程（检查用的子命令和实际调用），返回 cancelled。
 */
export async function testCliConnection(cfg: CliConfig, env: NodeJS.ProcessEnv, timeoutMs: number, signal: AbortSignal): Promise<CliTestResult> {
  const started = Date.now();
  const ms = () => Date.now() - started;
  const resolved = resolveCliCommand(cfg.provider, cfg.command, env);
  if (!resolved.ok) return { ok: false, reason: resolved.error.kind, message: firstLine(resolved.error.message), ms: ms() };
  const pre = await precheck(cfg, resolved.path, env, signal);
  if (!pre.ok) return { ...pre, ms: ms() };
  let model = cfg.model;
  try {
    const client = createCliClient(cfg, { timeoutMs, env });
    model = client.model || client.envModel || '';
    await client.complete({ ...PROBE, signal });
  } catch (err) {
    if (!(err instanceof LlmTruncatedError)) return { ok: false, ...probeFailure(err), ms: ms() };
  }
  return { ok: true, provider: cfg.provider, model, command: resolved.path, version: pre.version, ms: ms() };
}
