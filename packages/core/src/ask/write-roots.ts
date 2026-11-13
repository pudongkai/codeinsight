import os from 'node:os';
import path from 'node:path';
import { log } from '../log.js';
import { ReviewArgsError } from '../review/versions.js';
import { codeinsightHome, realPathOr } from '../settings/index.js';
import { isInsideDir, realDirOrUndefined } from '../util/paths.js';
import { isHomeConfigPath, normalizeSegment, WriteNotAllowedError } from './write-scope.js';

/** `--add-dir` 最多这么多个 */
export const MAX_ADD_DIRS = 10;

/** 不能作为可写目录、也不能在其下的系统目录（按真实路径前缀比较，不区分大小写） */
export const POSIX_SYSTEM_DIRS = ['/System', '/usr', '/bin', '/sbin', '/etc', '/var', '/private', '/opt', '/Library', '/Applications', '/dev', '/proc', '/boot'];

/** `--add-dir` 不合法：启动时报错退出 */
export class AddDirError extends ReviewArgsError {}

export interface AddDirCheckOptions {
  /** 用户主目录，默认 os.homedir() */
  home?: string;
  /** 系统目录名单，默认按平台取 */
  systemDirs?: string[];
  /** 默认 codeinsightHome() */
  codeinsightHome?: string;
  platform?: NodeJS.Platform;
}

/** 平台的系统目录：POSIX 名单；Windows 为系统目录、Program Files*、ProgramData 和用户的 AppData */
export function defaultSystemDirs(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform !== 'win32') return POSIX_SYSTEM_DIRS;
  const drive = env.SystemDrive ?? 'C:';
  const appData = env.USERPROFILE ? `${env.USERPROFILE}\\AppData` : undefined;
  const fromEnv = [env.SystemRoot, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.ProgramData, appData];
  const defaults = ['Windows', 'Program Files', 'Program Files (x86)', 'ProgramData'].map((d) => `${drive}\\${d}`);
  return [...fromEnv.filter((d): d is string => !!d), ...defaults];
}

interface CheckEnv {
  home: string;
  /** 小写，原样和真实路径两种形式都在 */
  systemDirs: string[];
  ciHome: string;
}

async function checkEnv(opts: AddDirCheckOptions): Promise<CheckEnv> {
  const given = opts.systemDirs ?? defaultSystemDirs(opts.platform);
  const reals = await Promise.all(given.map(realPathOr));
  return {
    home: (await realPathOr(opts.home ?? os.homedir())).toLowerCase(),
    systemDirs: [...new Set([...given, ...reals].map((d) => path.resolve(d).toLowerCase()))],
    ciHome: (await realPathOr(opts.codeinsightHome ?? codeinsightHome())).toLowerCase(),
  };
}

async function realDir(dir: string): Promise<string> {
  const real = await realDirOrUndefined(dir);
  if (!real) throw new AddDirError(`--add-dir ${dir}: not an existing directory`);
  return real;
}

/** 自身或某一级上级是 `.git`、`.codeinsight` 目录或 CODEINSIGHT_HOME */
function insideToolDir(real: string, ciHome: string): boolean {
  for (let cur = real; ; cur = path.dirname(cur)) {
    const name = normalizeSegment(path.basename(cur));
    if (name === '.git' || name === '.codeinsight' || cur.toLowerCase() === ciHome) return true;
    if (path.dirname(cur) === cur) return false;
  }
}

/** 检查一个 `--add-dir`，返回真实路径；不合法时抛 AddDirError */
async function checkAddDir(dir: string, env: CheckEnv): Promise<string> {
  const real = await realDir(dir);
  const lower = real.toLowerCase();
  const fail = (why: string) => new AddDirError(`--add-dir ${dir}: ${why}`);
  if (path.parse(real).root === real) throw fail('the file system root cannot be writable');
  if (isInsideDir(env.home, lower)) throw fail('the home directory and directories containing it cannot be writable; pass a directory inside it');
  if (isInsideDir(env.ciHome, lower)) throw fail('directories containing the CodeInsight settings directory cannot be writable');
  if (env.systemDirs.some((d) => isInsideDir(lower, d))) throw fail('system directories cannot be writable');
  if (isHomeConfigPath(lower, env.home)) throw fail('hidden directories and Library under the home directory cannot be writable');
  if (insideToolDir(real, env.ciHome)) throw fail('.git, .codeinsight and the CodeInsight settings directory cannot be writable');
  return real;
}

/**
 * 启动时检查 `--add-dir`：取真实路径后检查，按参数顺序去重，最多 MAX_ADD_DIRS 个。返回真实路径列表，
 * 第 i 个对应写入根目录名 `dir<i+1>`。不合法时抛 AddDirError。
 */
export async function resolveAddDirs(dirs: string[], opts: AddDirCheckOptions = {}): Promise<string[]> {
  if (dirs.length === 0) return [];
  const env = await checkEnv(opts);
  const out: string[] = [];
  for (const d of dirs) {
    const real = await checkAddDir(d, env);
    if (!out.some((o) => o.toLowerCase() === real.toLowerCase())) out.push(real);
  }
  if (out.length > MAX_ADD_DIRS) throw new AddDirError(`--add-dir: at most ${MAX_ADD_DIRS} directories`);
  log.info('write_roots', { dirs: out.length, names: out.map((d) => path.basename(d)) });
  return out;
}

/** 第 index 个 `--add-dir` 目录（从 0 开始）的写入根目录名 */
export function writeRootName(index: number): string {
  return `dir${index + 1}`;
}

export interface WriteRoot {
  /** `repo` 或 `dir1`、`dir2` … */
  name: string;
  path: string;
  /** 是否当前仓库（仓库以外只能新建文件） */
  repo: boolean;
}

/** 写入根目录名转成目录：不传为当前仓库；名字不存在时抛 WriteNotAllowedError 并列出可用的名字 */
export function resolveWriteRoot(name: string | undefined, repo: string, dirs: readonly string[]): WriteRoot {
  if (name === undefined || name === 'repo') return { name: 'repo', path: repo, repo: true };
  const i = dirs.findIndex((_, idx) => writeRootName(idx) === name);
  if (i < 0) {
    const names = ['repo', ...dirs.map((_, idx) => writeRootName(idx))].join(', ');
    throw new WriteNotAllowedError(`unknown root "${name}"; writable roots: ${names}`);
  }
  return { name, path: dirs[i]!, repo: false };
}

/** `/api/status` 和提示里的写入范围：只给目录名（最后一级），不给绝对路径 */
export function writeScopeView(dirs: readonly string[], hasRepo = true): { repo: boolean; dirs: string[] } {
  return { repo: hasRepo, dirs: dirs.map((d) => path.basename(d)) };
}
