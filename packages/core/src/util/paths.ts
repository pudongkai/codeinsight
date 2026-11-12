import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { isSafeRelativePath } from './relative-path.js';

/** 路径不允许访问：格式不合法（绝对路径、`..` 等），或跟随符号链接后落在根目录外 */
export class PathNotAllowedError extends Error {
  readonly code = 'path_not_allowed';
  constructor(readonly path: string) {
    super(`path not allowed: ${path}`);
  }
}

/**
 * 校验相对路径：POSIX 风格、不是绝对路径、没有 `.` / `..` / 空段、没有反斜杠和 NUL。
 * 调用方传入的应是已解码的路径（如 URLSearchParams 的取值），`..%2f` 这类编码此时已是 `../`。
 */
export function checkRelativePath(p: string): void {
  if (!isSafeRelativePath(p)) throw new PathNotAllowedError(p);
}

/** 按"文件不存在"处理的错误：路径过长、符号链接循环、中间段不是目录 */
const NOT_FOUND_CODES = new Set(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'ELOOP']);

/**
 * 把相对路径解析到 root 下，跟随符号链接后实际文件仍须在 root 内。
 * 文件或 root 不存在（或路径过长、链接循环）时返回 undefined；在 root 外时抛 PathNotAllowedError。
 */
export async function resolveInside(root: string, rel: string): Promise<string | undefined> {
  checkRelativePath(rel);
  let real: string;
  let rootReal: string;
  try {
    rootReal = await realpath(root);
    real = await realpath(path.join(root, ...rel.split('/')));
  } catch (err) {
    if (NOT_FOUND_CODES.has((err as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw err;
  }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new PathNotAllowedError(rel);
  return real;
}

/** 文件名去掉最后一个后缀（`a/b/api.py` → `api`）；以点开头且没有其他点的文件名（如 `.env`）原样返回 */
export function fileStem(file: string): string {
  const base = path.posix.basename(file);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}
