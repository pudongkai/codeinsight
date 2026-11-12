import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 先写同目录下的临时文件再改名，并发的读方不会读到写了一半的内容；
 * 临时文件名带 pid 和随机部分，同一进程里并发写同一个文件也不冲突。失败时删掉临时文件后抛出，由调用方决定怎么处理。
 */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(tmp, content);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
