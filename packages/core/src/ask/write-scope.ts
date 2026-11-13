import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { realPathOr } from '../settings/index.js';
import { isInsideDir, isNotFound, realDirOrUndefined } from '../util/paths.js';
import { isSafeRelativePath } from '../util/relative-path.js';

/** 写入路径或写入根目录不允许：reason 会回给模型，不含绝对路径 */
export class WriteNotAllowedError extends Error {
  readonly code = 'write_not_allowed';
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** 路径里任何一段（规范化后）是这些名字时不能写：版本库元数据、本工具的数据目录、依赖目录、钩子目录 */
export const FORBIDDEN_WRITE_SEGMENTS: ReadonlySet<string> = new Set(['.git', '.codeinsight', 'node_modules', '.husky', '.githooks']);

/** 零宽、方向控制和已废弃的格式控制字符（与 git 判断 HFS 上 .git 的名单一致）：显示不出来，可以把 `.git` 伪装成别的名字 */
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu;
const CONTROL = /[\u0000-\u001F\u007F]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9\u00B9\u00B2\u00B3]|lpt[0-9\u00B9\u00B2\u00B3])(\..*)?$/;

/**
 * 和禁止名单比较前的规范化：Unicode NFC、去掉零宽字符、去掉末尾的点和空格（Windows 会忽略它们）、转小写
 * （macOS / Windows 默认不区分大小写）
 */
export function normalizeSegment(seg: string): string {
  return seg.normalize('NFC').replace(INVISIBLE, '').replace(/[. ]+$/, '').toLowerCase();
}

/** Windows 上不能用的写法：`:`（备用数据流）、保留设备名、`~数字` 短文件名 */
function checkWindowsSegment(seg: string, normalized: string): void {
  if (seg.includes(':')) throw new WriteNotAllowedError('":" is not allowed in paths');
  if (WINDOWS_RESERVED.test(normalized)) throw new WriteNotAllowedError(`"${seg}" is a reserved device name`);
  if (/~\d/.test(seg)) throw new WriteNotAllowedError('short (8.3) file names are not allowed');
}

/**
 * 写入路径的格式检查（不访问磁盘）：相对路径、没有 `..` / 空段 / 反斜杠 / 控制字符，
 * 每一段规范化后不在禁止名单里；platform 为 win32 时另查 Windows 特有的写法
 */
export function checkWritePath(rel: string, platform: NodeJS.Platform = process.platform): void {
  if (!isSafeRelativePath(rel) || CONTROL.test(rel)) {
    throw new WriteNotAllowedError('the path must be relative to the root, using "/", without "..", empty segments or control characters');
  }
  for (const seg of rel.split('/')) {
    const n = normalizeSegment(seg);
    if (n === '') throw new WriteNotAllowedError(`"${seg}" is not a valid path segment`);
    if (FORBIDDEN_WRITE_SEGMENTS.has(n)) throw new WriteNotAllowedError(`writing inside ${n} is not allowed`);
    if (platform === 'win32') checkWindowsSegment(seg, n);
  }
}

export interface WriteScope {
  /** 写入根目录：当前仓库根或启动时指定的 --add-dir 目录 */
  root: string;
  /** 根目录下也不能写的目录：当前配置实际使用的数据目录、CODEINSIGHT_HOME */
  excluded: string[];
  /** 给出时（仓库以外的根目录）目标也不能落在这个主目录下的 Library 和以 `.` 开头的目录里 */
  home?: string;
  platform?: NodeJS.Platform;
}

/** 主目录下的 Library 和以 `.` 开头的目录（~/.ssh、~/.config 等）及其下面；按小写比较 */
export function isHomeConfigPath(p: string, home: string): boolean {
  const lower = p.toLowerCase();
  const h = home.toLowerCase();
  if (lower === h || !isInsideDir(lower, h)) return false;
  const first = path.relative(h, lower).split(path.sep)[0]!;
  return first === 'library' || first.startsWith('.');
}

export interface WriteTarget {
  /** 目标文件的绝对路径（根目录取真实路径后拼接） */
  abs: string;
  exists: boolean;
}

/** 路径存在且是符号链接（realpath 报不存在时说明它是悬空链接） */
async function isSymlink(p: string): Promise<boolean> {
  return (await lstat(p).catch(() => undefined))?.isSymbolicLink() === true;
}

/** 最近的已存在祖先的真实路径，以及它下面还不存在的各段；途中遇到悬空的符号链接时拒绝 */
async function nearestExisting(abs: string): Promise<{ real: string; rest: string[] }> {
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return { real: await realpath(cur), rest };
    } catch (err) {
      const parent = path.dirname(cur);
      if (!isNotFound(err) || parent === cur) throw err;
      if (await isSymlink(cur)) throw new WriteNotAllowedError('the path goes through a broken symbolic link');
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

async function rootReal(root: string): Promise<string> {
  const real = await realDirOrUndefined(root);
  if (!real) throw new WriteNotAllowedError('the write root no longer exists');
  return real;
}

/** 已存在的目标必须是普通文件，不能是符号链接 */
async function existingTarget(abs: string): Promise<boolean> {
  const st = await lstat(abs).catch((err: unknown) => {
    if (isNotFound(err)) return undefined;
    throw err;
  });
  if (!st) return false;
  if (st.isSymbolicLink()) throw new WriteNotAllowedError('the target is a symbolic link');
  if (!st.isFile()) throw new WriteNotAllowedError('the target is not a regular file');
  return true;
}

/** 目标实际所在位置（最近的已存在祖先取真实路径再接上其余各段）必须在根目录内，不在不能写的目录里 */
async function checkEffectivePath(scope: WriteScope, root: string, abs: string): Promise<void> {
  const { real, rest } = await nearestExisting(abs);
  if (!isInsideDir(real, root)) throw new WriteNotAllowedError('the path leads outside the root through a symbolic link');
  if (rest.length > 0 && !(await stat(real)).isDirectory()) throw new WriteNotAllowedError('a parent of the path is not a directory');
  const effective = path.join(real, ...rest);
  const excluded = await Promise.all(scope.excluded.map(realPathOr));
  if (excluded.some((d) => isInsideDir(effective, d))) throw new WriteNotAllowedError('writing into the CodeInsight data or settings directory is not allowed');
  if (scope.home && isHomeConfigPath(effective, await realPathOr(scope.home))) {
    throw new WriteNotAllowedError('writing into hidden directories or Library under the home directory is not allowed');
  }
}

/**
 * 检查写入路径并解析到磁盘：格式和名字（checkWritePath）；实际位置必须在根目录的真实路径之内，
 * 且不在数据目录、CODEINSIGHT_HOME（以及给了 home 时主目录的配置目录）之内；之后才看目标本身，
 * 已存在时不能是符号链接、必须是普通文件。不合法时抛 WriteNotAllowedError。
 */
export async function resolveWriteTarget(scope: WriteScope, rel: string): Promise<WriteTarget> {
  checkWritePath(rel, scope.platform);
  const root = await rootReal(scope.root);
  const abs = path.join(root, ...rel.split('/'));
  await checkEffectivePath(scope, root, abs);
  return { abs, exists: await existingTarget(abs) };
}
