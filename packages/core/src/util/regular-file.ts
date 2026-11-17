import { lstat, readFile } from 'node:fs/promises';

/** 只读普通文件的内容；不是普通文件（符号链接可能指向仓库外）时抛错 */
export async function readRegularFileStrict(file: string): Promise<string> {
  if (!(await lstat(file)).isFile()) throw new Error('not a regular file');
  return readFile(file, 'utf8');
}

/** 普通文件的内容；不存在、读不了或不是普通文件时为 undefined */
export async function readRegularFile(file: string): Promise<string | undefined> {
  try {
    return await readRegularFileStrict(file);
  } catch {
    return undefined;
  }
}
