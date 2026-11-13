import type { LlmConfig } from '../../config/index.js';
import type { CliLlmProvider } from '../../settings/types.js';
import type { LlmClient } from '../index.js';
import { ClaudeCodeClient } from './claude-code.js';
import { resolveCliCommand } from './command.js';
import { cliError } from './errors.js';
import { OPENCODE_PERMISSIONS_VERIFIED, OpencodeClient } from './opencode.js';
import { claudeSettingsPath, readClaudeSettingsEnvSync } from './process.js';

export { ClaudeCodeClient, CLAUDE_STRUCTURED_OUTPUT, claudeArgs, claudeEnv, classifyClaudeError, parseClaudeLine, claudeUsage, type ClaudeArgsOptions, type ClaudeOutput, type ClaudeResult, type CliClientOptions } from './claude-code.js';
export { commonCliDirs, resolveCliCommand, type ResolvedCommand, type ResolveCommandOptions } from './command.js';
export { cliError } from './errors.js';
export {
  classifyOpencodeError, flushOpencodeSessions, newOpencodeOutput, OPENCODE_PERMISSIONS_VERIFIED, OpencodeClient, opencodeArgs, opencodeConfig, opencodeEnv,
  opencodeGlobalMcpNames, opencodeRunContext, OpencodeSessionCleaner, opencodeSessions, opencodeUsage, parseOpencodeLine, type OpencodeOutput,
} from './opencode.js';
export { buildCliEnv, claudeSettingsPath, killActiveCliProcesses, resetCliShutdown, runCli, withCliTempDir, writeCliFile, type CliExit, type CliMode, type CliSpec, type CliUsage, type RunCliOptions } from './process.js';
export { flattenMessages } from './prompt.js';

export interface CreateCliClientOptions {
  timeoutMs: number;
  idleTimeoutMs?: number;
  /** 找命令和子进程环境的基础，默认 process.env */
  env?: NodeJS.ProcessEnv;
}

/**
 * 按配置建 CLI 客户端：先找命令，找不到时抛 CliError（调用方转成 llm_not_configured）；
 * opencode 的权限隔离没有确认生效前不可用。
 */
export function createCliClient(cfg: LlmConfig & { provider: CliLlmProvider }, opts: CreateCliClientOptions): LlmClient {
  if (cfg.provider === 'opencode' && !OPENCODE_PERMISSIONS_VERIFIED) {
    throw cliError('opencode', 'provider_unavailable', 'permission isolation has not been verified for this opencode version');
  }
  const env = opts.env ?? process.env;
  const resolved = resolveCliCommand(cfg.provider, cfg.command, env);
  if (!resolved.ok) throw resolved.error;
  const clientOpts = {
    command: resolved.path, model: cfg.model, extraEnv: cfg.extraEnv, timeoutMs: opts.timeoutMs, idleTimeoutMs: opts.idleTimeoutMs, baseEnv: env,
    envModel: cfg.model ? undefined : envModelOf(cfg.provider, env, cfg.extraEnv),
  };
  return cfg.provider === 'claude-code' ? new ClaudeCodeClient(clientOpts) : new OpencodeClient(clientOpts);
}

/**
 * 模型为空时实际用的模型由子进程环境决定：Claude Code 看合并后（base、用户 Claude Code 设置的 env、附加环境变量）的
 * ANTHROPIC_MODEL；opencode 没有对应的环境变量，模型来自它自己的配置
 */
export function envModelOf(provider: CliLlmProvider, base: NodeJS.ProcessEnv, extraEnv: Record<string, string> | undefined): string | undefined {
  if (provider !== 'claude-code') return undefined;
  const settings = readClaudeSettingsEnvSync(claudeSettingsPath({ ...base, ...extraEnv }));
  return extraEnv?.ANTHROPIC_MODEL || settings.ANTHROPIC_MODEL || base.ANTHROPIC_MODEL || undefined;
}

/** 是否本机 CLI 客户端（问答走 CLI 流程、用量按 CLI 统计） */
export function isCliClient(client: LlmClient): client is ClaudeCodeClient | OpencodeClient {
  return client instanceof ClaudeCodeClient || client instanceof OpencodeClient;
}
