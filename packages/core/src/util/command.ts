import { accessSync, constants, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** PATH 里找不到时再查的常见安装目录（GUI 启动的进程 PATH 往往不全） */
export function commonCliDirs(home: string): string[] {
  return [
    path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin',
    path.join(home, '.opencode', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, '.npm-global', 'bin'),
  ];
}

export interface FindCommandOptions {
  /** 已配置的命令（绝对路径或命令名），优先于 envVar */
  configured?: string;
  /** 可以指定命令路径或命令名的环境变量 */
  envVar?: string;
  /** 常见安装目录之后再查的目录 */
  extraDirs?: string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  /** 测试用：跳过缓存 */
  noCache?: boolean;
}

export type FoundCommand = (
  | { ok: true; path: string }
  | { ok: false; kind: 'command_not_found' | 'not_executable'; detail: string }
) & {
  /** 结果来自缓存时为 true，调用方据此避免每次都写日志 */
  cached?: boolean;
};

const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; result: FoundCommand }>();

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

function searchDirs(name: string, dirs: string[], platform: NodeJS.Platform): FoundCommand {
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
    return { ok: false, kind: 'not_executable', detail };
  }
  return { ok: false, kind: 'command_not_found', detail: `${name} was not found in PATH or common install directories` };
}

function findUncached(name: string, opts: FindCommandOptions, env: NodeJS.ProcessEnv): FoundCommand {
  const platform = opts.platform ?? process.platform;
  const wanted = opts.configured ?? (opts.envVar ? env[opts.envVar] || undefined : undefined) ?? name;
  const isAbsolute = platform === 'win32' ? path.win32.isAbsolute(wanted) : path.posix.isAbsolute(wanted);
  if (isAbsolute) {
    const c = checkFile(wanted, platform);
    if (c === 'ok') return { ok: true, path: wanted };
    return { ok: false, kind: c === 'missing' ? 'command_not_found' : 'not_executable', detail: wanted };
  }
  if (/[/\\]/.test(wanted)) return { ok: false, kind: 'command_not_found', detail: `${wanted} is not an absolute path or a command name` };
  const pathDirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  return searchDirs(wanted, [...pathDirs, ...commonCliDirs(opts.home ?? os.homedir()), ...(opts.extraDirs ?? [])], platform);
}

/**
 * 找外部命令的可执行文件：已配置的值或 envVar 指定的值是绝对路径时只检查它；否则按命令名依次查 PATH、
 * 常见安装目录、extraDirs。同步执行，结果按输入缓存 30 秒（之后新装的命令长时间运行的服务也能找到）。
 */
export function findCommand(name: string, opts: FindCommandOptions = {}): FoundCommand {
  const env = opts.env ?? process.env;
  const key = [
    name, opts.configured ?? '', opts.envVar ? env[opts.envVar] ?? '' : '', env.PATH ?? '', opts.platform ?? '', opts.home ?? '',
    ...(opts.extraDirs ?? []),
  ].join('\0');
  const hit = cache.get(key);
  if (!opts.noCache && hit && Date.now() - hit.at < CACHE_MS) return { ...hit.result, cached: true };
  const result = findUncached(name, opts, env);
  cache.set(key, { at: Date.now(), result });
  return result;
}
