import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 先写同目录下的临时文件再改名，并发的读方不会读到写了一半的内容；
 * 临时文件名带 pid 和随机部分，同一进程里并发写同一个文件也不冲突。失败时删掉临时文件后抛出，由调用方决定怎么处理。
 * 给了 mode 时临时文件一创建就是这个权限（再 chmod 一次，不受 umask 影响），改名后目标文件保持该权限，中间不会有更宽的时刻。
 */
export async function writeFileAtomic(file: string, content: string, opts: { mode?: number } = {}): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(tmp, content, opts.mode === undefined ? undefined : { mode: opts.mode });
    if (opts.mode !== undefined) await chmod(tmp, opts.mode);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
