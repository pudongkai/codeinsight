import { PathNotAllowedError, resolveInside as coreResolveInside } from '@codeinsight/core';
import { HttpError } from './respond.js';

/** core 的路径错误转成 403 `path_outside_repo`，其他错误原样返回 */
export function pathErrorToHttp(err: unknown): unknown {
  return err instanceof PathNotAllowedError ? new HttpError(403, 'path_outside_repo') : err;
}

/** 把相对路径解析到 root 下（跟随符号链接后仍须在 root 内）；不存在时返回 undefined，在 root 外时抛 403 */
export async function resolveInside(root: string, rel: string): Promise<string | undefined> {
  try {
    return await coreResolveInside(root, rel);
  } catch (err) {
    throw pathErrorToHttp(err);
  }
}
