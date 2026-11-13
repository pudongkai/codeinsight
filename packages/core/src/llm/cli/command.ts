import { accessSync, constants, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from '../../log.js';
import { DEFAULT_CLI_COMMAND, type CliLlmProvider } from '../../settings/types.js';
import type { CliError } from '../index.js';
import { cliError } from './errors.js';

/** PATH 里找不到时再查的常见安装目录（GUI 启动的进程 PATH 往往不全） */
export function commonCliDirs(home: string): string[] {
  return [
    path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin',
    path.join(home, '.opencode', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, '.npm-global', 'bin'),
  ];
}

export interface ResolveCommandOptions {
  platform?: NodeJS.Platform;
  home?: string;
  /** 测试用：跳过缓存 */
  noCache?: boolean;
}

export type ResolvedCommand = { ok: true; path: string } | { ok: false; error: CliError };

const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; result: ResolvedCommand }>();

type Check = 'ok' | 'missing' | 'not_executable';

function checkFile(file: string, platform: NodeJS.Platform): Check {
  try {
    if (!statSync(file).isFile()) return 'missing';
  } catch {
    return 'missing';
  }
  if (platform === 'win32') return /\.exe$/i.test(file) ? 'ok' : 'not_executable';
  try {
    accessSync(file, constants.X_OK);
    return 'ok';
  } catch {
    return 'not_executable';
  }
}

/** Windows 上只认 .exe：.cmd 要经过 shell 才能运行，找到时报 not_executable */
function candidates(dir: string, name: string, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return [path.join(dir, name)];
  return /\.(exe|cmd|bat)$/i.test(name) ? [path.join(dir, name)] : [path.join(dir, `${name}.exe`), path.join(dir, `${name}.cmd`)];
}

function searchDirs(provider: CliLlmProvider, name: string, dirs: string[], platform: NodeJS.Platform): ResolvedCommand {
  let notExecutable: string | undefined;
  for (const dir of dirs) {
    for (const file of candidates(dir, name, platform)) {
      const c = checkFile(file, platform);
      if (c === 'ok') return { ok: true, path: file };
      if (c === 'not_executable') notExecutable ??= file;
    }
  }
  if (notExecutable) {
    const detail = platform === 'win32' ? `${notExecutable} (use the path of the .exe file)` : notExecutable;
    return { ok: false, error: cliError(provider, 'not_executable', detail) };
  }
  return { ok: false, error: cliError(provider, 'command_not_found', `${name} was not found in PATH or common install directories`) };
}

function resolveUncached(provider: CliLlmProvider, configured: string | undefined, env: NodeJS.ProcessEnv, opts: ResolveCommandOptions): ResolvedCommand {
  const platform = opts.platform ?? process.platform;
  const name = configured ?? DEFAULT_CLI_COMMAND[provider];
  const isAbsolute = platform === 'win32' ? path.win32.isAbsolute(name) : path.posix.isAbsolute(name);
  if (isAbsolute) {
    const c = checkFile(name, platform);
    if (c === 'ok') return { ok: true, path: name };
    return { ok: false, error: cliError(provider, c === 'missing' ? 'command_not_found' : 'not_executable', name) };
  }
  if (/[/\\]/.test(name)) return { ok: false, error: cliError(provider, 'command_not_found', `${name} is not an absolute path or a command name`) };
  const pathDirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  return searchDirs(provider, name, [...pathDirs, ...commonCliDirs(opts.home ?? os.homedir())], platform);
}

/**
 * 找 CLI 可执行文件：配置了绝对路径时只检查它；配置了命令名或没配置时按 PATH、再按常见安装目录找。
 * 同步执行（调用方 createLlmClient 是同步的），结果按 (provider, configured, PATH) 缓存 30 秒。
 */
export function resolveCliCommand(provider: CliLlmProvider, configured: string | undefined, env: NodeJS.ProcessEnv = process.env, opts: ResolveCommandOptions = {}): ResolvedCommand {
  const key = [provider, configured ?? '', env.PATH ?? '', opts.platform ?? '', opts.home ?? ''].join('\0');
  const hit = cache.get(key);
  if (!opts.noCache && hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  const result = resolveUncached(provider, configured, env, opts);
  cache.set(key, { at: Date.now(), result });
  if (result.ok) log.debug('llm_cli_command_resolved', { provider, command: result.path });
  else log.warn('llm_cli_command_missing', { provider, kind: result.error.kind, configured: configured !== undefined });
  return result;
}
