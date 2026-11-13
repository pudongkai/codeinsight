import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isInsideDir, isNotFound, isOutsideRelative, PathNotAllowedError } from './paths.js';

export interface AtomicWriteOptions {
  /** 目标文件的权限；不给时按 umask */
  mode?: number;
  /** 排他创建：用 link() 把临时文件接到目标，目标已存在时抛 EEXIST，不覆盖 */
  exclusive?: boolean;
  /** 临时文件写好、改名（或 link）之前调用，抛错时放弃写入（用于最后再检查一次目标位置） */
  beforeCommit?: () => Promise<void>;
  /**
   * 给出时目标必须在这个目录之内：缺的上级目录逐级创建，每一级的真实路径都要在它之内，
   * 新建的一级必须是目录而不是符号链接；不满足时抛 PathNotAllowedError，不写临时文件
   */
  root?: string;
}

/** 新建的一级：建好后确认是目录不是链接（期间被换成链接时拒绝） */
async function makeOneLevel(dir: string): Promise<void> {
  await mkdir(dir).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  });
  const st = await lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new PathNotAllowedError(dir);
}

/** 从 root 往下逐级确认（缺的非递归创建）到 dir，每一级的真实路径都在 root 的真实路径之内 */
async function ensureDirInside(root: string, dir: string): Promise<void> {
  const rootReal = await realpath(root);
  const rel = path.relative(root, dir);
  if (isOutsideRelative(rel)) throw new PathNotAllowedError(dir);
  let cur = root;
  for (const seg of rel === '' ? [] : rel.split(path.sep)) {
    cur = path.join(cur, seg);
    const exists = await lstat(cur).then(() => true, (err: unknown) => {
      if (isNotFound(err)) return false;
      throw err;
    });
    if (!exists) await makeOneLevel(cur);
    if (!isInsideDir(await realpath(cur), rootReal)) throw new PathNotAllowedError(cur);
  }
}

/**
 * 先写同目录下的临时文件再改名，并发的读方不会读到写了一半的内容；
 * 临时文件名带 pid 和随机部分，同一进程里并发写同一个文件也不冲突。失败时删掉临时文件后抛出，由调用方决定怎么处理。
 * 给了 mode 时临时文件一创建就是这个权限（再 chmod 一次，不受 umask 影响），改名后目标文件保持该权限，中间不会有更宽的时刻。
 */
export async function writeFileAtomic(file: string, content: string | Uint8Array, opts: AtomicWriteOptions = {}): Promise<void> {
  if (opts.root !== undefined) await ensureDirInside(opts.root, path.dirname(file));
  else await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, content, opts.mode === undefined ? { flag: 'wx' } : { mode: opts.mode, flag: 'wx' });
    if (opts.mode !== undefined) await chmod(tmp, opts.mode);
    await opts.beforeCommit?.();
    if (opts.exclusive) await link(tmp, file);
    else await rename(tmp, file);
  } finally {
    // 改名成功后临时文件已不存在，force 忽略；link 之后要删掉临时文件这个名字
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}
