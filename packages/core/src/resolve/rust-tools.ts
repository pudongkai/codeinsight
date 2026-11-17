import { existsSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from '../log.js';
import type { FallbackReason } from '../model/types.js';
import { runProcess, ScipRunError } from '../scip/runner.js';
import { findCommand, type FoundCommand } from '../util/command.js';
import { prepareRunBase, RunDirUnsafe } from './rust-run-dir.js';

/** rust-analyzer 和 rust-src 的安装命令（状态栏提示里也写这一条） */
export const RUST_ANALYZER_INSTALL = 'rustup component add rust-analyzer rust-src';

const TOOL_TIMEOUT_MS = 30_000;
/** rustup 代理的文件名：cargo、rust-analyzer 等经它转到工具链里的实际程序 */
const RUSTUP_PROXY_NAMES = new Set(['rustup', 'rustup-init']);
/** `overrideCommand` 用的空命令，只认系统目录里的 */
const TRUE_CANDIDATES = ['/usr/bin/true', '/bin/true'];

/** 一个工具链下运行 Rust 解析要用的程序（都是绝对路径） */
export interface RustTools {
  cargo: string;
  rustAnalyzer: string;
  rustc: string;
  /** rustup 工具链名；没有 rustup 时为空 */
  toolchain?: string;
  /** `rust-analyzer --version` 的第一行 */
  version: string;
  /** 工具链里有没有 rust-src（标准库源码） */
  rustSrc: boolean;
  rustup?: string;
  /** `true` 命令，作为 build script 的替代命令 */
  trueBin: string;
  /** rust-analyzer 由 CODEINSIGHT_RUST_ANALYZER 指定（不是 rustup 代理）：换工具链时也不改用工具链里的 */
  analyzerPinned?: boolean;
}

export type RustToolsLookup =
  | { ok: true; tools: RustTools }
  | { ok: false; reason: FallbackReason; detail: string };

export interface ToolRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ToolRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** 运行一个查询命令（`--version`、`rustup which` 等）；所有调用都显式给 cwd 和 env */
export type ToolRunner = (bin: string, args: string[], opts: ToolRunOptions) => Promise<ToolRunResult>;

export interface FindRustToolsOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  run?: ToolRunner;
  /** 测试用：跳过命令查找的缓存 */
  noCache?: boolean;
  /** 每个查询命令的超时上限，默认 30 秒 */
  timeoutMs?: number;
  /** 中止时结束正在运行的查询命令并抛出 ScipRunError */
  signal?: AbortSignal;
  /** 查询命令的工作目录；默认用 prepareRunBase() 准备的用户私有目录（测试可指定） */
  runBase?: string;
}

class NotFound extends Error {}

/** 启动失败（程序不存在、没有执行权限等）按找不到处理 */
const defaultRunner: ToolRunner = async (bin, args, opts) => {
  let exit;
  try {
    exit = await runProcess({ bin, args, cwd: opts.cwd, env: opts.env, timeoutMs: opts.timeoutMs, signal: opts.signal, captureStdout: true });
  } catch (err) {
    throw new NotFound(`${path.basename(bin)} failed to start: ${(err as Error).message}`);
  }
  return { code: exit.timedOut ? null : exit.code, stdout: exit.stdout, stderr: exit.stderr };
};

interface LookupContext {
  env: NodeJS.ProcessEnv;
  home: string;
  run: ToolRunner;
  cwd: string;
  noCache?: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** 查询命令的环境：不带用户设的 RUSTUP_TOOLCHAIN，给了 toolchain 时固定为它，不自动安装工具链 */
export function rustupEnv(base: NodeJS.ProcessEnv, toolchain?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, RUSTUP_AUTO_INSTALL: '0' };
  delete env.RUSTUP_TOOLCHAIN;
  if (toolchain) env.RUSTUP_TOOLCHAIN = toolchain;
  return env;
}

async function runChecked(ctx: LookupContext, bin: string, args: string[], toolchain?: string): Promise<string> {
  if (ctx.signal?.aborted) throw new ScipRunError('rust toolchain lookup cancelled');
  const r = await ctx.run(bin, args, { cwd: ctx.cwd, env: rustupEnv(ctx.env, toolchain), timeoutMs: ctx.timeoutMs, signal: ctx.signal });
  if (ctx.signal?.aborted) throw new ScipRunError('rust toolchain lookup cancelled');
  if (r.code !== 0) {
    const first = (r.stderr.trim().split('\n')[0] || `exit code ${r.code}`).trim();
    throw new NotFound(`${path.basename(bin)} ${args.join(' ')}: ${first}`);
  }
  return r.stdout.trim();
}

function find(ctx: LookupContext, name: string, envVar: string): FoundCommand {
  return findCommand(name, { envVar, extraDirs: [path.join(ctx.home, '.cargo', 'bin')], env: ctx.env, home: ctx.home, noCache: ctx.noCache });
}

function required(name: string, found: FoundCommand): string {
  if (!found.ok) throw new NotFound(`${name}: ${found.detail}`);
  return found.path;
}

function findTrue(): string {
  const bin = TRUE_CANDIDATES.find((p) => findCommand(p).ok);
  if (!bin) throw new NotFound(`true: none of ${TRUE_CANDIDATES.join(', ')} is executable`);
  return bin;
}

function isRustupProxy(bin: string): boolean {
  try {
    return RUSTUP_PROXY_NAMES.has(path.basename(realpathSync(bin)));
  } catch {
    return false;
  }
}

/** `rustup default` 的输出 `stable-aarch64-apple-darwin (default)` 取工具链名 */
async function defaultToolchain(ctx: LookupContext, rustup: string): Promise<string> {
  const name = (await runChecked(ctx, rustup, ['default'])).split(/\s+/)[0];
  if (!name) throw new NotFound('rustup default: no default toolchain');
  return name;
}

/** rust-analyzer 找不到时在说明后加上安装命令；其他错误原样返回 */
function withInstallHint(err: unknown): unknown {
  return err instanceof NotFound ? new NotFound(`${err.message} (install: ${RUST_ANALYZER_INSTALL})`) : err;
}

const versions = new Map<string, string>();

/** `rust-analyzer --version` 的第一行，按实际程序路径和修改时间缓存；运行失败（如 rustup 代理下没装组件）时按找不到处理 */
async function analyzerVersion(ctx: LookupContext, bin: string, toolchain?: string): Promise<string> {
  const key = `${bin}\0${statSync(bin, { throwIfNoEntry: false })?.mtimeMs ?? 0}`;
  const hit = versions.get(key);
  if (hit) return hit;
  let out: string;
  try {
    out = await runChecked(ctx, bin, ['--version'], toolchain);
  } catch (err) {
    throw withInstallHint(err);
  }
  const version = out.split('\n')[0] || 'unknown';
  versions.set(key, version);
  return version;
}

async function hasRustSrc(ctx: LookupContext, rustc: string, toolchain?: string): Promise<boolean> {
  const sysroot = await runChecked(ctx, rustc, ['--print', 'sysroot'], toolchain);
  return existsSync(path.join(sysroot, 'lib', 'rustlib', 'src', 'rust', 'library'));
}

interface BaseTools {
  cargo: string;
  analyzerCommand: string;
  /** analyzerCommand 由环境变量指定且不是 rustup 代理，直接用它 */
  analyzerPinned: boolean;
  rustup?: string;
  trueBin: string;
}

/** 工具链里的 rust-analyzer：有 rustup 时经 `rustup which` 取得，没装组件时按找不到处理 */
async function toolchainAnalyzer(ctx: LookupContext, base: BaseTools, toolchain?: string): Promise<string> {
  if (base.analyzerPinned || !base.rustup || !toolchain) return realpathSync(base.analyzerCommand);
  try {
    return await runChecked(ctx, base.rustup, ['which', 'rust-analyzer'], toolchain);
  } catch (err) {
    throw withInstallHint(err);
  }
}

/** 工具链里的 rustc：有 rustup 时经 `rustup which` 取得，否则取和 cargo 同目录的 */
async function toolchainRustc(ctx: LookupContext, base: BaseTools, toolchain?: string): Promise<string> {
  if (base.rustup && toolchain) return runChecked(ctx, base.rustup, ['which', 'rustc'], toolchain);
  const rustc = path.join(path.dirname(realpathSync(base.cargo)), 'rustc');
  if (!existsSync(rustc)) throw new NotFound(`rustc: not found next to ${base.cargo}`);
  return rustc;
}

/** 某个工具链下的 rust-analyzer、rustc 实际路径和 rust-src */
async function toolchainTools(ctx: LookupContext, base: BaseTools, toolchain?: string): Promise<RustTools> {
  const rustAnalyzer = await toolchainAnalyzer(ctx, base, toolchain);
  const rustc = await toolchainRustc(ctx, base, toolchain);
  const version = await analyzerVersion(ctx, rustAnalyzer, toolchain);
  const rustSrc = await hasRustSrc(ctx, rustc, toolchain);
  return {
    cargo: base.cargo, rustAnalyzer, rustc, version, rustSrc, trueBin: base.trueBin,
    ...(toolchain ? { toolchain } : {}), ...(base.rustup ? { rustup: base.rustup } : {}),
    ...(base.analyzerPinned ? { analyzerPinned: true } : {}),
  };
}

async function lookup(ctx: LookupContext): Promise<RustTools> {
  const cargo = required('cargo', find(ctx, 'cargo', 'CODEINSIGHT_CARGO'));
  const analyzerCommand = required('rust-analyzer', find(ctx, 'rust-analyzer', 'CODEINSIGHT_RUST_ANALYZER'));
  const rustupFound = find(ctx, 'rustup', 'CODEINSIGHT_RUSTUP');
  const rustup = rustupFound.ok ? rustupFound.path : undefined;
  for (const [name, bin] of [['cargo', cargo], ['rust-analyzer', analyzerCommand]] as const) {
    if (!rustup && isRustupProxy(bin)) throw new NotFound(`${name} is a rustup proxy but rustup was not found`);
  }
  const trueBin = findTrue();
  const analyzerPinned = Boolean(ctx.env.CODEINSIGHT_RUST_ANALYZER) && !isRustupProxy(analyzerCommand);
  const toolchain = rustup ? await defaultToolchain(ctx, rustup) : undefined;
  return toolchainTools(ctx, { cargo, analyzerCommand, analyzerPinned, rustup, trueBin }, toolchain);
}

/** 查询命令在用户私有目录里运行，rustup 不会读到共用临时目录或仓库里的 rust-toolchain.toml */
async function lookupContext(opts: FindRustToolsOptions): Promise<LookupContext> {
  const env = opts.env ?? process.env;
  return {
    env, home: opts.home ?? os.homedir(), run: opts.run ?? defaultRunner, cwd: await prepareRunBase(opts.runBase, env), noCache: opts.noCache,
    timeoutMs: Math.max(1, Math.min(opts.timeoutMs ?? TOOL_TIMEOUT_MS, TOOL_TIMEOUT_MS)), signal: opts.signal,
  };
}

/**
 * 查找 cargo、rust-analyzer（rustup 可选）并确定默认工具链。所有子进程都在用户私有目录里运行、不自动安装工具链；
 * CODEINSIGHT_RUST_ANALYZER 指定的不是 rustup 代理时直接用它，rustc 和 rust-src 仍按工具链取。
 * 找不到、rustup 代理下没装组件、`rustup default` 失败、命令启动失败都按 not_found；私有目录不安全和其他意外错误按 failed；
 * 被中止时抛出 ScipRunError
 */
export async function findRustTools(opts: FindRustToolsOptions = {}): Promise<RustToolsLookup> {
  if ((opts.platform ?? process.platform) === 'win32') return { ok: false, reason: 'not_found', detail: 'rust-analyzer is not supported on Windows' };
  try {
    const tools = await lookup(await lookupContext(opts));
    log.info('rust_tools_lookup', { found: true, rustAnalyzer: tools.rustAnalyzer, toolchain: tools.toolchain, version: tools.version, rustSrc: tools.rustSrc });
    return { ok: true, tools };
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    if (err instanceof NotFound) {
      log.info('rust_tools_lookup', { found: false, detail: err.message });
      return { ok: false, reason: 'not_found', detail: err.message };
    }
    const detail = (err as Error).message.split('\n')[0]!;
    log.warn('rust_tools_lookup', { found: false, error: detail });
    return { ok: false, reason: 'failed', detail };
  }
}

/** `rustup toolchain list` 里有没有这个 channel（`stable` 匹配 `stable-aarch64-apple-darwin`） */
function listedToolchain(list: string, channel: string): boolean {
  return list.split('\n').map((l) => l.trim().split(/\s+/)[0] ?? '').some((name) => name === channel || name.startsWith(`${channel}-`));
}

/**
 * 运行根目录用的工具：channel 已安装且带 rust-analyzer 时用该工具链重新取 rust-analyzer、rustc 和 rust-src，
 * 否则用默认工具链（日志 rust_toolchain_fallback 记原因）。没有 rustup 时总是默认
 */
export async function toolsForChannel(tools: RustTools, channel: string | undefined, opts: FindRustToolsOptions = {}): Promise<RustTools> {
  if (!channel || !tools.rustup || channel === tools.toolchain) return tools;
  let ctx: LookupContext;
  try {
    ctx = await lookupContext(opts);
  } catch (err) {
    if (err instanceof RunDirUnsafe) throw new ScipRunError(err.message);
    throw err;
  }
  try {
    const list = await runChecked(ctx, tools.rustup, ['toolchain', 'list']);
    if (!listedToolchain(list, channel)) throw new NotFound('toolchain not installed');
    const base = { cargo: tools.cargo, analyzerCommand: tools.rustAnalyzer, analyzerPinned: tools.analyzerPinned === true, rustup: tools.rustup, trueBin: tools.trueBin };
    return await toolchainTools(ctx, base, channel);
  } catch (err) {
    if (!(err instanceof NotFound)) throw err;
    log.info('rust_toolchain_fallback', { channel, toolchain: tools.toolchain, reason: err.message.split('\n')[0] });
    return tools;
  }
}
