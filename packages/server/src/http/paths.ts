import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './respond.js';

/**
 * 校验请求里的相对路径：POSIX 风格、不是绝对路径、没有 `.` / `..` 段、没有反斜杠和 NUL。
 * 查询参数已由 URLSearchParams 解码，`..%2f` 这类编码在这里已是 `../`。
 */
export function checkRelativePath(p: string): void {
  if (p === '' || p.includes('\0') || p.includes('\\') || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) {
    throw new HttpError(403, 'path_outside_repo');
  }
  if (p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) throw new HttpError(403, 'path_outside_repo');
}

/** 按"文件不存在"处理的错误：路径过长、符号链接循环、中间段不是目录 */
const NOT_FOUND_CODES = new Set(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'ELOOP']);

/**
 * 把相对路径解析到 root 下，跟随符号链接后实际文件仍须在 root 内。
 * 文件不存在（或路径过长、链接循环）时返回 undefined；在 root 外时抛 403。
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
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new HttpError(403, 'path_outside_repo');
  return real;
}
