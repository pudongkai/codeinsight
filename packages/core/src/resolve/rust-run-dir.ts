import { existsSync, realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { log } from '../log.js';
import { rustRunBaseCandidates } from '../store/data-dir.js';

/** 运行目录的上级目录不安全（不是当前用户私有的目录，或上级目录里有 cargo 会读到的配置） */
export class RunDirUnsafe extends Error {}

/** 建好目录（不存在时为 0700），检查它不是符号链接、属主是当前用户 */
async function ensureOwnedDir(dir: string): Promise<number> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new RunDirUnsafe(`${dir} is a symlink or not a directory`);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new RunDirUnsafe(`${dir} is not owned by the current user`);
  return st.mode;
}

/** 建好目录并设为 0700，检查它不是符号链接、属主是当前用户；返回真实路径 */
async function ensurePrivateDir(dir: string): Promise<string> {
  await ensureOwnedDir(dir);
  await chmod(dir, 0o700);
  return realpath(dir);
}

/** 缓存目录本身（XDG_CACHE_HOME 或 ~/.cache）：当前用户所有、不是符号链接，组和其他用户不可写；不改它的权限 */
async function checkCacheRoot(dir: string): Promise<void> {
  const mode = await ensureOwnedDir(dir);
  if ((mode & 0o022) !== 0) throw new RunDirUnsafe(`${dir} is writable by other users`);
  await checkAncestorsPrivate(path.dirname(await realpath(dir)));
}

/**
 * dir 及其每一级上级目录（按真实路径）都只能由当前用户或 root 所有、组和其他用户不可写（sticky 位也不算），
 * 否则别的用户可以在其中放 cargo 会读到的配置或替换下级目录
 */
async function checkAncestorsPrivate(dir: string): Promise<void> {
  const uid = process.getuid?.();
  for (let cur = dir; ; cur = path.dirname(cur)) {
    const st = await lstat(cur);
    if (uid !== undefined && st.uid !== uid && st.uid !== 0) throw new RunDirUnsafe(`${cur} is owned by another user`);
    if ((st.mode & 0o022) !== 0) throw new RunDirUnsafe(`${cur} is writable by other users`);
    if (path.dirname(cur) === cur) return;
  }
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** cargo 从运行目录向上会读的配置：`.cargo/config(.toml)`（CARGO_HOME 本身除外）和 Cargo.toml */
const ANCESTOR_CARGO_FILES = ['.cargo/config', '.cargo/config.toml', 'Cargo.toml'];

/** dir 及其每一级上级目录里第一个 cargo 会读到的配置文件；没有时为 undefined */
export function cargoConfigAbove(dir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const cargoHome = realpathOrSelf(env.CARGO_HOME ?? path.join(os.homedir(), '.cargo'));
  for (let cur = dir; ; cur = path.dirname(cur)) {
    for (const rel of ANCESTOR_CARGO_FILES) {
      const file = path.join(cur, rel);
      if (!existsSync(file)) continue;
      if (rel.startsWith('.cargo/') && realpathOrSelf(path.join(cur, '.cargo')) === cargoHome) continue;
      return file;
    }
    if (path.dirname(cur) === cur) return undefined;
  }
}

/**
 * 建好并检查一个候选目录：给定的目录（override，只在测试里用）只检查它本身；默认候选还要求所在缓存目录及其各级上级目录
 * 不能被别的用户写、codeinsight 这一级是当前用户私有的。最后确认它和各级上级目录里没有 cargo 会读到的配置。
 * 不满足时抛出 RunDirUnsafe
 */
async function prepareCandidate(dir: string, env: NodeJS.ProcessEnv, override: boolean): Promise<string> {
  let base: string;
  try {
    if (!override) {
      await checkCacheRoot(path.dirname(path.dirname(dir)));
      await ensurePrivateDir(path.dirname(dir));
    }
    base = await ensurePrivateDir(dir);
  } catch (err) {
    if (err instanceof RunDirUnsafe) throw err;
    throw new RunDirUnsafe(`cannot prepare the rust run directory ${dir}: ${(err as Error).message}`);
  }
  assertNoCargoConfigAbove(base, env);
  return base;
}

/**
 * base 及其上级目录里有 cargo 会读到的配置时抛出 RunDirUnsafe，说明里写明文件和处理办法。
 * 准备目录时和每次运行 cargo、rust-analyzer 前都要检查：准备之后上级目录里仍可能新出现配置
 */
export function assertNoCargoConfigAbove(base: string, env: NodeJS.ProcessEnv = process.env): void {
  const config = cargoConfigAbove(base, env);
  if (config) {
    throw new RunDirUnsafe(
      `cargo configuration above the rust run directory: ${config} (move it away, or set XDG_CACHE_HOME to a directory with no cargo configuration above it)`,
    );
  }
}

/**
 * Rust 子进程（工具查找、cargo、rust-analyzer）运行目录的上级：测试给了 override 时只用它；否则按顺序试
 * rustRunBaseCandidates()，用第一个通过检查的。都不通过时抛出 RunDirUnsafe
 */
export async function prepareRunBase(override?: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (override) return prepareCandidate(override, env, true);
  const problems: string[] = [];
  for (const dir of rustRunBaseCandidates(env, env.HOME || os.homedir())) {
    try {
      return await prepareCandidate(dir, env, false);
    } catch (err) {
      if (!(err instanceof RunDirUnsafe)) throw err;
      log.warn('rust_run_base_skipped', { dir, reason: err.message });
      problems.push(err.message);
    }
  }
  throw new RunDirUnsafe(problems.join('; '));
}
