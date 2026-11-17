import { copyFile, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { BinaryWriter } from '@bufbuild/protobuf/wire';
import { cargoRootDir, parseToolchainChannel, rustFileUnit, type RustPackage } from '../extract/rust-cargo.js';
import { RUST_STD_CRATES } from '../extract/rust-index.js';
import type { ExtractedFile } from '../extract/types.js';
import { log } from '../log.js';
import { appendScipDocuments } from '../scip/merge.js';
import { decodeScipIndex, type ScipIndex } from '../scip/reader.js';
import { runCargoMetadata, runRustAnalyzerScip, ScipRunError, type ExitInfo } from '../scip/runner.js';
import { RUST_RUN_DIR_PREFIX } from '../store/data-dir.js';
import { writeFileAtomic } from '../util/atomic-file.js';
import { FAILED_RERESOLVE_AFTER_MS } from './edge-sources.js';
import { assertNoCargoConfigAbove, prepareRunBase, RunDirUnsafe } from './rust-run-dir.js';
import { readRegularFile } from '../util/regular-file.js';
import { rustupEnv, toolsForChannel, type RustTools } from './rust-tools.js';

/** 一个运行 rust-analyzer 的根目录：带 `[workspace]` 的目录，或不属于任何工作区的包目录 */
export interface RustRunRoot {
  /** 相对快照根目录，根目录为空字符串 */
  dir: string;
  packages: RustPackage[];
}

/** 不属于工作区、路径里含这些目录的包是测试数据或示例，不作为运行根目录 */
const NON_ROOT_SEGMENTS = new Set(['tests', 'fixtures', 'testdata', 'examples']);
/** rust-analyzer 依赖加载失败、改用 `--no-deps` 时的提示 */
export const NO_DEPS_MARKER = 'returning succeeded result with `--no-deps`';
const LOCK_WAIT_MARKER = 'Blocking waiting for file lock';
const RUST_SYMBOL = /^rust-analyzer cargo (\S+) /;
const TOOLCHAIN_FILES = ['rust-toolchain', 'rust-toolchain.toml'];
/** 运行目录名里的 pid 之后由 mkdtemp 补 6 位随机字符 */
const RUN_DIR_KEY_LENGTH = 16;

/** 运行根目录，按目录排序 */
export function rustRunRoots(packages: ReadonlyMap<string, RustPackage>): RustRunRoot[] {
  const roots = new Map<string, RustPackage[]>();
  for (const pkg of packages.values()) {
    if (pkg.workspaceRoot === undefined && pkg.dir.split('/').some((s) => NON_ROOT_SEGMENTS.has(s))) continue;
    const dir = cargoRootDir(pkg);
    roots.set(dir, [...(roots.get(dir) ?? []), pkg]);
  }
  return [...roots].sort(([a], [b]) => a.localeCompare(b)).map(([dir, pkgs]) => ({ dir, packages: pkgs }));
}

/** 每个文件所在的运行根目录；不在任何运行根目录里的文件没有对应项 */
export function rustFileRoots(files: readonly ExtractedFile[], packages: ReadonlyMap<string, RustPackage>, roots: readonly RustRunRoot[]): Map<string, string> {
  const rootOfPackage = new Map<string, string>();
  for (const r of roots) for (const p of r.packages) rootOfPackage.set(p.dir, r.dir);
  const out = new Map<string, string>();
  for (const f of files) {
    const dir = rustFileUnit(f.path, packages).packageDir;
    const root = dir === undefined ? undefined : rootOfPackage.get(dir);
    if (root !== undefined) out.set(f.path, root);
  }
  return out;
}

/**
 * 把快照里的一个文件放到运行目录的同一相对路径：只放普通文件（符号链接等跳过，避免带进仓库外的文件），
 * .rs 先尝试硬链接，失败（跨文件系统等）时复制。放置失败记 warn 并跳过该文件；optional 的文件不存在时直接跳过
 */
async function placeFile(snapshotDir: string, runDir: string, rel: string, hardLink: boolean, optional = false): Promise<void> {
  const src = path.join(snapshotDir, rel);
  const dst = path.join(runDir, rel);
  try {
    const st = await lstat(src);
    if (!st.isFile()) {
      log.info('scip_rust_file_skipped', { file: rel, reason: st.isSymbolicLink() ? 'symlink' : 'not a regular file' });
      return;
    }
    await mkdir(path.dirname(dst), { recursive: true });
    if (hardLink) {
      try {
        await link(src, dst);
        return;
      } catch {
        // 跨文件系统时改为复制
      }
    }
    await copyFile(src, dst);
  } catch (err) {
    if (optional && (err as NodeJS.ErrnoException).code === 'ENOENT') return;
    log.warn('scip_rust_file_skipped', { file: rel, error: (err as Error).message });
  }
}

/** 要放进运行目录的 Cargo.toml、Cargo.lock 所在目录：各包目录和工作区根目录 */
function cargoDirs(packages: ReadonlyMap<string, RustPackage>): string[] {
  const dirs = new Set<string>();
  for (const p of packages.values()) {
    dirs.add(p.dir);
    dirs.add(cargoRootDir(p));
  }
  return [...dirs];
}

/** 在 base 下建一个空的运行目录（mkdtemp，权限 0700） */
async function makeRunDir(base: string, contentKey: string): Promise<string> {
  return mkdtemp(path.join(base, `${RUST_RUN_DIR_PREFIX}${contentKey.slice(0, RUN_DIR_KEY_LENGTH)}.${process.pid}.`));
}

/** 按快照里的相对路径只放 Rust 文件和 Cargo.toml、Cargo.lock；仓库里的 .cargo/、rust-toolchain(.toml) 等其他文件都不放 */
async function fillRunDir(runDir: string, snapshotDir: string, rsFiles: readonly string[], packages: ReadonlyMap<string, RustPackage>): Promise<void> {
  for (const f of rsFiles) await placeFile(snapshotDir, runDir, f, true);
  for (const dir of cargoDirs(packages)) {
    for (const name of ['Cargo.toml', 'Cargo.lock']) await placeFile(snapshotDir, runDir, path.posix.join(dir, name), false, true);
  }
}

/** 在 base 下建运行目录并放入文件；放置过程出错时删除运行目录 */
export async function createRustRunDir(
  snapshotDir: string, contentKey: string, rsFiles: readonly string[], packages: ReadonlyMap<string, RustPackage>, base: string,
): Promise<string> {
  const runDir = await makeRunDir(await realpath(base), contentKey);
  try {
    await fillRunDir(runDir, snapshotDir, rsFiles, packages);
    return runDir;
  } catch (err) {
    await rm(runDir, { recursive: true, force: true });
    throw err;
  }
}

/** 从环境里删除的变量：cargo 会经它们运行别的 rustc、wrapper 或 rustdoc */
const REMOVED_ENV = ['CARGO_BUILD_RUSTC', 'CARGO_BUILD_RUSTC_WRAPPER', 'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER', 'CARGO_BUILD_RUSTDOC', 'RUSTDOC'];

/**
 * cargo 和 rust-analyzer 的环境变量：固定工具链、cargo 和 rustc，不使用 rustc wrapper、不自动安装工具链、
 * 构建目录放在运行目录里、git 不等待输入；CARGO_HOME 和代理设置沿用用户环境
 */
export function rustCargoEnv(tools: RustTools, runDir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = rustupEnv(base, tools.toolchain);
  for (const k of [...REMOVED_ENV, 'CARGO_NET_OFFLINE']) delete env[k];
  return {
    ...env,
    CARGO: tools.cargo,
    RUSTC: tools.rustc,
    RUSTC_WRAPPER: '',
    RUSTC_WORKSPACE_WRAPPER: '',
    CARGO_TARGET_DIR: path.join(runDir, 'target'),
    CARGO_TERM_COLOR: 'never',
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
  };
}

/** rust-analyzer 配置：build script 和 proc-macro 的构建都换成什么也不做的 true，启用全部 features */
export function rustAnalyzerConfig(trueBin: string): string {
  return JSON.stringify({ cargo: { buildScripts: { overrideCommand: [trueBin] }, features: 'all' } });
}

/** 运行根目录往上到快照根目录，最近的 rust-toolchain(.toml) 的 channel；同一目录两种文件都有时旧格式优先 */
export async function rootToolchainChannel(snapshotDir: string, rootDir: string): Promise<string | undefined> {
  let dir = rootDir;
  for (;;) {
    for (const name of TOOLCHAIN_FILES) {
      const text = await readRegularFile(path.join(snapshotDir, dir, name));
      const channel = text === undefined ? undefined : parseToolchainChannel(name, text);
      if (channel) return channel;
    }
    if (dir === '') return undefined;
    const parent = path.posix.dirname(dir);
    dir = parent === '.' ? '' : parent;
  }
}

/** 根目录里的代码用到了不在本根目录的依赖（路径第一段是某个包的依赖名） */
export function usesExternalDeps(root: RustRunRoot, files: readonly ExtractedFile[]): boolean {
  const local = new Set(root.packages.map((p) => p.name.replace(/-/g, '_')));
  const deps = new Set(root.packages.flatMap((p) => p.deps).map((d) => d.replace(/-/g, '_')).filter((d) => !local.has(d)));
  return deps.size > 0 && files.some((f) => f.rust?.pathRoots.some((r) => deps.has(r)));
}

/** 索引里有没有指向本根目录的包和标准库以外的 crate 的引用 */
export function hasExternalReference(index: ScipIndex, root: RustRunRoot): boolean {
  const local = new Set(root.packages.map((p) => p.name));
  for (const doc of index.documents) {
    for (const occ of doc.occurrences) {
      const pkg = RUST_SYMBOL.exec(occ.symbol)?.[1];
      if (pkg && !local.has(pkg) && !RUST_STD_CRATES.has(pkg)) return true;
    }
  }
  return false;
}

/** 依赖加载失败的兜底检查：代码用到了外部依赖，索引里却没有任何跨 crate 的引用 */
export function dependenciesMissing(index: ScipIndex, root: RustRunRoot, files: readonly ExtractedFile[]): boolean {
  return usesExternalDeps(root, files) && !hasExternalReference(index, root);
}

/** 运行一个根目录时逐行看 stderr：依赖加载失败的提示、等待包缓存锁 */
export class RustStderrWatch {
  noDeps = false;
  lockWait = false;

  constructor(private readonly root: string) {}

  readonly onLine = (line: string): void => {
    if (line.includes(NO_DEPS_MARKER)) this.noDeps = true;
    if (!this.lockWait && line.includes(LOCK_WAIT_MARKER)) {
      this.lockWait = true;
      log.info('cargo_lock_wait', { root: this.root });
    }
  };
}

class RootFailure extends Error {}

function firstError(exit: ExitInfo): string {
  const lines = exit.stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => l.startsWith('error')) ?? lines[0] ?? `exit code ${exit.code ?? exit.signal}`;
}

export interface RustScipOptions {
  /** 快照源码根目录 */
  snapshotDir: string;
  contentKey: string;
  /** Rust 文件的提取结果 */
  files: readonly ExtractedFile[];
  packages: ReadonlyMap<string, RustPackage>;
  tools: RustTools;
  /** 合并后的索引缓存文件 `<contentKey>.rust.scip`；旁边写同名 `.json` 记录各根目录的结果 */
  output: string;
  /** 所有根目录合计的超时 */
  timeoutMs: number;
  signal?: AbortSignal;
  /** 测试用：保留运行目录 */
  keepRunDir?: boolean;
  /** 测试用：运行目录的上级目录，默认 rustRunBaseCandidates() 中第一个可用的 */
  tmpDir?: string;
  /** 子进程的基础环境变量，默认当前进程的 */
  env?: NodeJS.ProcessEnv;
}

export interface RustRootResult {
  dir: string;
  ok: boolean;
  /** 失败原因的第一行 */
  error?: string;
}

export interface RustScipResult {
  roots: RustRootResult[];
  /** 如 `rust_src_missing` */
  warnings: string[];
  /** 结果产生的时间 */
  at: number;
  /** keepRunDir 时保留的运行目录 */
  runDir?: string;
}

interface RunContext {
  opts: RustScipOptions;
  /** 运行目录的上级（用户私有目录），工具查找也在这里运行 */
  base: string;
  runDir: string;
  configPath: string;
  deadline: number;
  fileRoots: Map<string, string>;
  rustSrcMissing: boolean;
}

function remaining(ctx: RunContext): number {
  const ms = ctx.deadline - Date.now();
  if (ms <= 0) throw new RootFailure(`timed out after ${ctx.opts.timeoutMs}ms`);
  return ms;
}

/** 运行 cargo、rust-analyzer 前再确认私有目录的上级没有新出现 cargo 配置；有时本根目录失败 */
function checkRunBase(ctx: RunContext): void {
  try {
    assertNoCargoConfigAbove(ctx.base, ctx.opts.env);
  } catch (err) {
    if (err instanceof RunDirUnsafe) throw new RootFailure(err.message);
    throw err;
  }
}

const LOCK_TIMEOUT_REASON = 'timed out waiting for the cargo package cache lock';

/** cargo metadata 先离线跑，失败再联网跑一次；返回之后是否离线运行。超时（含等包缓存锁）时不再重跑 */
async function checkMetadata(ctx: RunContext, cwd: string, env: NodeJS.ProcessEnv, watch: RustStderrWatch): Promise<boolean> {
  const run = (offline: boolean): Promise<ExitInfo> => runCargoMetadata({
    bin: ctx.opts.tools.cargo, cwd, env, offline, timeoutMs: remaining(ctx), signal: ctx.opts.signal, onStderr: watch.onLine,
  });
  const failed = (exit: ExitInfo): RootFailure => new RootFailure(`cargo metadata failed: ${
    exit.timedOut ? (watch.lockWait ? LOCK_TIMEOUT_REASON : `timed out after ${ctx.opts.timeoutMs}ms`) : firstError(exit)}`);
  checkRunBase(ctx);
  const offline = await run(true);
  if (offline.code === 0) return true;
  if (offline.timedOut) throw failed(offline);
  checkRunBase(ctx);
  const online = await run(false);
  if (online.code === 0) return false;
  throw failed(online);
}

/** 在一个根目录运行 cargo metadata 和 rust-analyzer scip，检查依赖加载；返回索引内容 */
async function indexRoot(ctx: RunContext, root: RustRunRoot, seq: number): Promise<Uint8Array> {
  const channel = await rootToolchainChannel(ctx.opts.snapshotDir, root.dir);
  const tools = await toolsForChannel(ctx.opts.tools, channel, { env: ctx.opts.env, signal: ctx.opts.signal, timeoutMs: remaining(ctx), runBase: ctx.base });
  if (!tools.rustSrc) ctx.rustSrcMissing = true;
  const cwd = path.join(ctx.runDir, root.dir);
  if (!existsSync(path.join(cwd, 'Cargo.toml'))) throw new RootFailure('Cargo.toml was not placed in the run directory (not a regular file)');
  const env = rustCargoEnv(tools, ctx.runDir, ctx.opts.env);
  const watch = new RustStderrWatch(root.dir);
  const offline = await checkMetadata(ctx, cwd, env, watch);
  const output = path.join(ctx.runDir, `${seq}.scip`);
  checkRunBase(ctx);
  try {
    await runRustAnalyzerScip({
      bin: tools.rustAnalyzer, cwd, output, configPath: ctx.configPath, env: offline ? { ...env, CARGO_NET_OFFLINE: 'true' } : env,
      timeoutMs: remaining(ctx), signal: ctx.opts.signal, onStderr: watch.onLine,
    });
  } catch (err) {
    if (watch.lockWait && /timed out/.test((err as Error).message)) throw new RootFailure(`rust-analyzer ${LOCK_TIMEOUT_REASON}`);
    throw err;
  }
  if (watch.noDeps) throw new RootFailure('dependencies failed to load (rust-analyzer fell back to --no-deps)');
  const bytes = await readFile(output);
  const files = ctx.opts.files.filter((f) => ctx.fileRoots.get(f.path) === root.dir);
  if (dependenciesMissing(decodeScipIndex(bytes), root, files)) throw new RootFailure('dependencies failed to load (no cross-crate references in index)');
  return bytes;
}

async function runRoot(ctx: RunContext, root: RustRunRoot, seq: number, merged: BinaryWriter): Promise<RustRootResult> {
  try {
    const bytes = await indexRoot(ctx, root, seq);
    appendScipDocuments(merged, bytes, root.dir, (p) => ctx.fileRoots.get(p) === root.dir);
    return { dir: root.dir, ok: true };
  } catch (err) {
    if (ctx.opts.signal?.aborted) throw err;
    if (!(err instanceof RootFailure || err instanceof ScipRunError)) throw err;
    const error = (err as Error).message.split('\n')[0]!;
    log.warn('scip_rust_root_failed', { root: root.dir, error });
    return { dir: root.dir, ok: false, error };
  }
}

function metaPath(output: string): string {
  return output.replace(/\.scip$/, '.json');
}

/** 合并的索引和各根目录结果写到缓存；结果文件最后写，读缓存时以它为准 */
async function writeCache(output: string, index: Uint8Array, result: RustScipResult): Promise<void> {
  await writeFileAtomic(output, index);
  await writeFileAtomic(metaPath(output), JSON.stringify({ roots: result.roots, warnings: result.warnings, at: result.at }));
}

/**
 * 读缓存：索引和结果都在、且没有失败的根目录或失败发生在 FAILED_RERESOLVE_AFTER_MS 以内时返回，
 * 否则按没有缓存处理（失败的根目录过一段时间后重新运行）
 */
export async function readRustScipCache(output: string, now = Date.now()): Promise<{ result: RustScipResult; index: Uint8Array } | undefined> {
  try {
    const result = JSON.parse(await readFile(metaPath(output), 'utf8')) as RustScipResult;
    if (result.roots.some((r) => !r.ok) && now - result.at >= FAILED_RERESOLVE_AFTER_MS) return undefined;
    return { result, index: await readFile(output) };
  } catch {
    return undefined;
  }
}

async function runAllRoots(ctx: RunContext, roots: RustRunRoot[]): Promise<RustScipResult> {
  const merged = new BinaryWriter();
  const results: RustRootResult[] = [];
  for (const [i, root] of roots.entries()) results.push(await runRoot(ctx, root, i, merged));
  const result: RustScipResult = { roots: results, warnings: ctx.rustSrcMissing ? ['rust_src_missing'] : [], at: Date.now() };
  await writeCache(ctx.opts.output, merged.finish(), result);
  log.info('scip_rust_indexed', { roots: results.length, failed: results.filter((r) => !r.ok).length, warnings: result.warnings });
  return result;
}

/** 运行目录准备不了时，所有根目录都按失败返回（不写缓存） */
function setupFailed(roots: RustRunRoot[], error: string): RustScipResult {
  log.warn('scip_rust_run_dir_unsafe', { error });
  return { roots: roots.map((r) => ({ dir: r.dir, ok: false, error })), warnings: [], at: Date.now() };
}

/**
 * 在用户私有的运行目录中，对每个运行根目录跑 cargo metadata 和 rust-analyzer scip，成功的根目录的索引
 * 加上根目录前缀后合并写到 output。单个根目录失败不影响其他根目录；运行目录不安全时全部按失败返回；
 * 被中止时抛出异常。运行目录结束时删除
 */
export async function buildRustScipIndex(opts: RustScipOptions): Promise<RustScipResult> {
  const roots = rustRunRoots(opts.packages);
  const fileRoots = rustFileRoots(opts.files, opts.packages, roots);
  const rsFiles = opts.files.map((f) => f.path);
  let base: string;
  try {
    base = await prepareRunBase(opts.tmpDir, opts.env);
  } catch (err) {
    if (!(err instanceof RunDirUnsafe)) throw err;
    return setupFailed(roots, err.message);
  }
  const runDir = await createRustRunDir(opts.snapshotDir, opts.contentKey, rsFiles, opts.packages, base);
  try {
    log.info('scip_rust_start', { roots: roots.map((r) => r.dir), files: rsFiles.length, runDir, timeoutMs: opts.timeoutMs });
    const configPath = path.join(runDir, 'ra-config.json');
    await writeFile(configPath, rustAnalyzerConfig(opts.tools.trueBin));
    const ctx: RunContext = { opts, base, runDir, configPath, deadline: Date.now() + opts.timeoutMs, fileRoots, rustSrcMissing: false };
    const result = await runAllRoots(ctx, roots);
    return opts.keepRunDir ? { ...result, runDir } : result;
  } finally {
    if (!opts.keepRunDir) await rm(runDir, { recursive: true, force: true });
  }
}
