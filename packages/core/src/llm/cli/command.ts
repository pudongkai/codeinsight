import { log } from '../../log.js';
import { DEFAULT_CLI_COMMAND, type CliLlmProvider } from '../../settings/types.js';
import type { CliError } from '../index.js';
import { commonCliDirs, findCommand } from '../../util/command.js';
import { cliError } from './errors.js';

export { commonCliDirs };

export interface ResolveCommandOptions {
  platform?: NodeJS.Platform;
  home?: string;
  /** 测试用：跳过缓存 */
  noCache?: boolean;
}

export type ResolvedCommand = { ok: true; path: string } | { ok: false; error: CliError };

/**
 * 找 CLI 可执行文件：配置了绝对路径时只检查它；配置了命令名或没配置时按 PATH、再按常见安装目录找。
 * 同步执行（调用方 createLlmClient 是同步的），查找结果缓存 30 秒（见 findCommand）。
 */
export function resolveCliCommand(provider: CliLlmProvider, configured: string | undefined, env: NodeJS.ProcessEnv = process.env, opts: ResolveCommandOptions = {}): ResolvedCommand {
  const found = findCommand(DEFAULT_CLI_COMMAND[provider], { ...opts, configured, env });
  const result: ResolvedCommand = found.ok ? { ok: true, path: found.path } : { ok: false, error: cliError(provider, found.kind, found.detail) };
  if (found.cached) return result;
  if (result.ok) log.debug('llm_cli_command_resolved', { provider, command: result.path });
  else log.warn('llm_cli_command_missing', { provider, kind: result.error.kind, configured: configured !== undefined });
  return result;
}
