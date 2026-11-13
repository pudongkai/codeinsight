import { LlmTruncatedError, type CliError, type LlmClient, type LlmRequest } from '../index.js';
import { cliError, firstLine, kindOfStatus, runErrorOf } from './errors.js';
import { logCliExit, logCliFailure, runCli, withCliTempDir, writeCliFile, type CliExit, type CliSpec, type CliUsage } from './process.js';
import { flattenMessages } from './prompt.js';

/**
 * 是否用 `--json-schema` 让 Claude Code 按 schema 返回结构化输出（`--tools ""` 下仍然可用）；
 * 关掉时只靠提示词说明格式，由调用方的 parse 校验
 */
export const CLAUDE_STRUCTURED_OUTPUT = true;
/** 结构化输出由 CLI 内部的工具实现，至少要两轮 */
export const CLAUDE_COMPLETE_MAX_TURNS = 3;

/** 隔离用户环境的固定参数：不加载内置工具、用户 MCP、设置文件、斜杠命令，不保存会话，未预先允许的工具一律拒绝 */
const ISOLATION_ARGS = [
  '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--permission-mode', 'dontAsk',
  '--no-session-persistence', '--disable-slash-commands',
];

export type ClaudeArgsOptions =
  | { mode: 'complete'; systemFile: string; jsonSchema?: Record<string, unknown>; model?: string }
  | { mode: 'ask'; systemFile: string; mcpConfigFile: string; allowedTools: string[]; maxTurns: number; model?: string };

/** 启动参数：只有固定选项、临时文件路径、JSON Schema 和经过校验的模型名，prompt 走 stdin */
export function claudeArgs(o: ClaudeArgsOptions): string[] {
  const model = o.model ? [`--model=${o.model}`] : [];
  if (o.mode === 'complete') {
    const schema = o.jsonSchema && CLAUDE_STRUCTURED_OUTPUT ? ['--json-schema', JSON.stringify(o.jsonSchema)] : [];
    return ['-p', '--output-format', 'json', ...ISOLATION_ARGS, '--system-prompt-file', o.systemFile, ...schema, '--max-turns', String(CLAUDE_COMPLETE_MAX_TURNS), ...model];
  }
  return [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...ISOLATION_ARGS,
    '--mcp-config', o.mcpConfigFile, '--allowedTools', o.allowedTools.join(','),
    '--max-turns', String(o.maxTurns), '--system-prompt-file', o.systemFile, ...model,
  ];
}

/** 固定环境变量：输出上限，不读 CLAUDE.md 和自动记忆，不发非必要流量 */
export function claudeEnv(maxTokens?: number): Record<string, string> {
  return {
    ...(maxTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens) } : {}),
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

export interface ClaudeResult {
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  total_cost_usd?: number;
  num_turns?: number;
  stop_reason?: string | null;
  terminal_reason?: string;
  api_error_status?: number | null;
  errors?: string[];
}

/** 输出各行里要用的部分：init 行的模型、assistant 消息的 error 字段、最后的 result 行 */
export interface ClaudeOutput {
  model?: string;
  assistantError?: string;
  result?: ClaudeResult;
}

/** 收一行输出；未知类型的行忽略 */
export function parseClaudeLine(out: ClaudeOutput, value: unknown): void {
  const line = value as { type?: unknown; subtype?: unknown; model?: unknown; error?: unknown } | null;
  if (line?.type === 'system' && line.subtype === 'init' && typeof line.model === 'string') out.model = line.model;
  else if (line?.type === 'assistant' && typeof line.error === 'string') out.assistantError = line.error;
  else if (line?.type === 'result') out.result = line as ClaudeResult;
}

export function claudeUsage(r: ClaudeResult | undefined): CliUsage {
  const u = r?.usage;
  const input = u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) : undefined;
  return { inputTokens: input, outputTokens: u?.output_tokens, costUsd: r?.total_cost_usd, numTurns: r?.num_turns };
}

const AUTH_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'cloud_credential_error']);
const ASSISTANT_KINDS: Record<string, CliError['kind']> = {
  billing_error: 'quota', rate_limit: 'rate_limited', overloaded: 'server_error', server_error: 'server_error',
  model_not_found: 'model_not_found', invalid_request: 'invalid_request',
};

/** 账号和服务端错误：assistant 的 error 字段优先，其次是出错的 result 文本和 HTTP 状态 */
function accountErrorKind(out: ClaudeOutput): CliError['kind'] | undefined {
  const e = out.assistantError;
  const r = out.result;
  const text = r?.is_error ? (r.result ?? '') : '';
  if ((e && AUTH_ERRORS.has(e)) || text.startsWith('Not logged in')) return 'not_logged_in';
  if (e && ASSISTANT_KINDS[e]) return ASSISTANT_KINDS[e];
  if (/credit balance|usage limit/i.test(text)) return 'quota';
  return r?.is_error ? kindOfStatus(r.api_error_status ?? undefined) : undefined;
}

function resultDetail(r: ClaudeResult): string {
  return firstLine(r.errors?.[0] ?? r.result ?? r.subtype);
}

/**
 * 按先后顺序取第一个命中的分类：运行问题 → 账号和服务端错误 → 截断 → 没有 result 行 → result 表示失败。
 * 成功时返回 undefined。
 */
export function classifyClaudeError(out: ClaudeOutput, exit: CliExit, maxTokens = 0): CliError | LlmTruncatedError | undefined {
  const run = runErrorOf('claude-code', exit);
  if (run) return run;
  const r = out.result;
  const kind = accountErrorKind(out);
  if (kind) return cliError('claude-code', kind, r ? resultDetail(r) : out.assistantError);
  if (out.assistantError === 'max_output_tokens' || r?.stop_reason === 'max_tokens') return new LlmTruncatedError(maxTokens);
  if (!r) {
    if (exit.exitCode !== 0) return cliError('claude-code', 'cli_failed', firstLine(exit.stderrTail) || `exit code ${exit.exitCode ?? exit.signal}`);
    return cliError('claude-code', 'bad_response', 'no result line in the output');
  }
  if (r.subtype === 'error_max_structured_output_retries') return cliError('claude-code', 'bad_response', 'the reply did not match the JSON schema');
  if (r.is_error || (r.subtype && r.subtype !== 'success')) return cliError('claude-code', 'cli_failed', resultDetail(r));
  return undefined;
}

/** 成功的 result：有结构化输出时返回它的 JSON 文本，否则返回文字 */
function replyText(r: ClaudeResult): string | undefined {
  if (r.structured_output !== undefined && r.structured_output !== null) return JSON.stringify(r.structured_output);
  return r.result || undefined;
}

export interface CliClientOptions {
  command: string;
  model: string;
  extraEnv?: Record<string, string>;
  timeoutMs: number;
  idleTimeoutMs?: number;
  /** 子进程环境的基础，默认 process.env */
  baseEnv?: NodeJS.ProcessEnv;
  /** 模型为空时由合并后的环境变量决定的模型 */
  envModel?: string;
}

/** 用本机 Claude Code（`claude -p`）完成一次请求，用它自己的登录状态 */
export class ClaudeCodeClient implements LlmClient {
  readonly provider = 'claude-code';
  readonly model: string;
  readonly baseUrl = undefined;
  readonly envModel?: string;
  constructor(readonly opts: CliClientOptions) {
    this.model = opts.model;
    this.envModel = opts.envModel;
  }

  complete(req: LlmRequest): Promise<string> {
    return withCliTempDir(async (dir) => {
      const systemFile = await writeCliFile(dir, 'system.md', req.system);
      const spec: CliSpec = {
        provider: 'claude-code', command: this.opts.command, mode: 'complete', model: this.model, cwd: dir, extraEnv: this.opts.extraEnv,
        args: claudeArgs({ mode: 'complete', systemFile, jsonSchema: req.jsonSchema, model: this.model }),
        env: claudeEnv(req.maxTokens), stdin: flattenMessages(req.messages),
      };
      const out: ClaudeOutput = {};
      // json 输出模式结束前没有任何输出，只看总时长
      const exit = await runCli(spec, { signal: req.signal, timeoutMs: this.opts.timeoutMs, baseEnv: this.opts.baseEnv, onLine: (v) => parseClaudeLine(out, v) });
      logCliExit(spec, exit, claudeUsage(out.result));
      const err = classifyClaudeError(out, exit, req.maxTokens) ?? (replyText(out.result!) === undefined ? cliError('claude-code', 'bad_response', 'the result has no text') : undefined);
      if (err) {
        if (!(err instanceof LlmTruncatedError)) logCliFailure(spec, err, exit);
        throw err;
      }
      return replyText(out.result!)!;
    });
  }
}
