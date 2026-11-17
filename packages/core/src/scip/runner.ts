import { spawn, type ChildProcess } from 'node:child_process';
import { realpath, rename, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { log } from '../log.js';

const STDERR_TAIL_LINES = 20;

export interface ScipRunOptions {
  /** 快照源码根目录 */
  cwd: string;
  output: string;
  /** 内容为 `[]` 的环境文件，scip-python 不再调用 pip 读取包列表 */
  environment: string;
  projectVersion: string;
  timeoutMs: number;
  /** scip-python 入口脚本，默认用依赖里的版本；测试时可换成别的脚本 */
  bin?: string;
  /** 中止时结束子进程并删除临时输出，以 ScipRunError 结束 */
  signal?: AbortSignal;
}

export class ScipRunError extends Error {}

export function defaultScipPythonBin(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve('@sourcegraph/scip-python/package.json')), 'index.js');
}

function tail(text: string): string {
  return text.trimEnd().split('\n').slice(-STDERR_TAIL_LINES).join('\n');
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  stderr: string;
  /** captureStdout 为 true 时的标准输出，否则为空字符串 */
  stdout: string;
}

interface ActiveRun {
  /** 输出的临时文件；没有输出文件的命令为 undefined */
  tmp?: string;
  closed: Promise<void>;
}

/** 本进程正在运行的 SCIP 索引子进程（scip-python、scip-go 等），进程退出前用 killActiveScipProcesses 结束它们 */
const active = new Map<ChildProcess, ActiveRun>();

/** 结束子进程所在的整个进程组（它启动的 go 等子进程一起结束）；Windows 上只结束子进程本身 */
function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    // 进程组已经不在了
  }
}

export interface ProcessRun {
  bin: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  /** 输出的临时文件，被强制结束时删除；没有输出文件的命令不传 */
  tmp?: string;
  /** 不传时继承当前进程的环境变量 */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** 收集标准输出（如 go list 的结果）；默认丢弃 */
  captureStdout?: boolean;
  /** 标准错误按行逐行交给调用方（不受只保留末尾 64KB 的限制） */
  onStderr?: (line: string) => void;
}

const STDERR_KEEP_BYTES = 64 * 1024;

/** 按行切分分段到达的文字，每凑齐一行交给 onLine；flush 交出最后不带换行的部分 */
function lineSplitter(onLine: (line: string) => void): { push(text: string): void; flush(): void } {
  let pending = '';
  return {
    push(text) {
      const parts = (pending + text).split('\n');
      pending = parts.pop()!;
      for (const line of parts) onLine(line.replace(/\r$/, ''));
    },
    flush() {
      if (pending) onLine(pending.replace(/\r$/, ''));
      pending = '';
    },
  };
}

/** 在单独的进程组里运行一个索引命令并等它结束；超时或中止时结束整组。不因退出码抛错，结果在返回值里 */
export function runProcess(run: ProcessRun): Promise<ExitInfo> {
  return new Promise((resolve, reject) => {
    const child = spawn(run.bin, run.args, {
      cwd: run.cwd, env: run.env, stdio: ['ignore', run.captureStdout ? 'pipe' : 'ignore', 'pipe'],
      detached: process.platform !== 'win32', windowsHide: true,
    });
    active.set(child, { tmp: run.tmp, closed: new Promise((r) => child.once('close', () => r())) });
    const stdout: Buffer[] = [];
    child.stdout?.on('data', (d: Buffer) => stdout.push(d));
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    const lines = run.onStderr ? lineSplitter(run.onStderr) : undefined;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => {
      stderr = (stderr + d).slice(-STDERR_KEEP_BYTES);
      lines?.push(d);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, run.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      killGroup(child);
    };
    run.signal?.addEventListener('abort', onAbort, { once: true });
    const done = (): void => {
      clearTimeout(timer);
      run.signal?.removeEventListener('abort', onAbort);
      active.delete(child);
    };
    child.on('error', (err) => {
      done();
      reject(err);
    });
    child.on('close', (code, signal) => {
      done();
      lines?.flush();
      resolve({ code, signal, timedOut, aborted, stderr, stdout: Buffer.concat(stdout).toString('utf8') });
    });
  });
}

/** 被中止、超时或退出码不为 0 时抛出 ScipRunError */
function checkExit(name: string, exit: ExitInfo, timeoutMs: number): void {
  if (exit.aborted) throw new ScipRunError(`${name} cancelled`);
  if (exit.timedOut) throw new ScipRunError(`${name} timed out after ${timeoutMs}ms\n${tail(exit.stderr)}`);
  if (exit.code !== 0) throw new ScipRunError(`${name} exited with code ${exit.code ?? exit.signal}\n${tail(exit.stderr)}`);
}

/** 临时输出非空时改名为正式输出，否则抛出 ScipRunError */
async function keepOutput(name: string, tmp: string, output: string, exit: ExitInfo): Promise<void> {
  const size = (await stat(tmp).catch(() => undefined))?.size ?? 0;
  if (size === 0) throw new ScipRunError(`${name} produced no output\n${tail(exit.stderr)}`);
  await rename(tmp, output);
}

/**
 * 运行 scip-python 生成 index.scip。先写临时文件，成功后再改名，缓存里不会留下半个文件。
 * cwd 要传真实路径：经过符号链接的路径（如 macOS 的 /tmp）会让 scip-python 认为文件不在项目内而输出空索引。
 */
export async function runScipPython(opts: ScipRunOptions): Promise<void> {
  const cwd = await realpath(opts.cwd);
  const tmp = `${opts.output}.${process.pid}.tmp`;
  const args = [
    opts.bin ?? defaultScipPythonBin(), 'index', '--quiet',
    '--cwd', cwd,
    '--environment', opts.environment,
    '--output', tmp,
    '--project-version', opts.projectVersion,
  ];
  if (opts.signal?.aborted) throw new ScipRunError('scip-python cancelled');
  log.info('scip_python_start', { args: args.slice(1), timeoutMs: opts.timeoutMs });
  const started = Date.now();
  try {
    const exit = await runProcess({ bin: process.execPath, args, cwd, timeoutMs: opts.timeoutMs, tmp, signal: opts.signal });
    log.info('scip_python_exit', { code: exit.code, signal: exit.signal, timedOut: exit.timedOut, aborted: exit.aborted, ms: Date.now() - started });
    checkExit('scip-python', exit, opts.timeoutMs);
    await keepOutput('scip-python', tmp, opts.output, exit);
  } finally {
    await rm(tmp, { force: true });
  }
}

export interface ScipGoRunOptions {
  /** scip-go 可执行文件 */
  bin: string;
  /** go 可执行文件，用来先检查包能否全部加载 */
  goBin: string;
  /** go.mod 所在目录 */
  moduleDir: string;
  output: string;
  /** go 和 scip-go 共用的环境变量 */
  env: NodeJS.ProcessEnv;
  /** go list 和 scip-go 合计的超时 */
  timeoutMs: number;
  signal?: AbortSignal;
}

/** 依次拼接的多个 JSON 对象（`go list -json` 的输出）拆开解析 */
export function parseJsonStream(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth++ === 0) start = i;
    } else if (ch === '}' && --depth === 0) {
      out.push(JSON.parse(text.slice(start, i + 1)));
    }
  }
  return out;
}

interface GoListPackage {
  Error?: { Err?: string };
  DepsErrors?: { Err?: string }[];
}

/** CGO_ENABLED=0 时只有 cgo 文件的包报这个错，不影响其他包的索引，不算加载错误 */
const IGNORED_GO_LIST_ERROR = 'build constraints exclude all Go files';

/** `go list -e -json` 输出里第一个包加载错误（包自身的 Error 或依赖的 DepsErrors）；没有时为 undefined */
export function goListError(stdout: string): string | undefined {
  for (const pkg of parseJsonStream(stdout) as GoListPackage[]) {
    const errors = [pkg.Error, ...(pkg.DepsErrors ?? [])].filter((e) => e !== undefined && e !== null);
    const hit = errors.find((e) => !(e.Err ?? '').includes(IGNORED_GO_LIST_ERROR));
    if (hit) return hit.Err || 'package load error';
  }
  return undefined;
}

/**
 * 先用 go list 检查 module 里的包和依赖能否全部加载：scip-go 加载依赖失败时仍正常退出，
 * 只产出缺了引用的索引，所以有加载错误时按失败处理
 */
async function checkGoPackages(opts: ScipGoRunOptions, cwd: string, timeoutMs: number): Promise<void> {
  const args = ['list', '-e', '-json', './...'];
  const exit = await runProcess({ bin: opts.goBin, args, cwd, timeoutMs, env: opts.env, signal: opts.signal, captureStdout: true });
  checkExit('go list', exit, timeoutMs);
  const error = goListError(exit.stdout);
  if (error) throw new ScipRunError(`go list: ${error}`);
}

/**
 * 对一个 Go module 运行 scip-go 生成索引（文档路径相对 module 目录）：先 go list 检查加载错误，再 scip-go index。
 * 固定 --module-version：不传时 scip-go 在 git 仓库里用提交号作版本，符号文字会随提交变化。
 * 先写临时文件，成功后再改名；中止或超时时结束整个进程组
 */
export async function runScipGo(opts: ScipGoRunOptions): Promise<void> {
  if (opts.signal?.aborted) throw new ScipRunError('scip-go cancelled');
  const cwd = await realpath(opts.moduleDir);
  const deadline = Date.now() + opts.timeoutMs;
  const tmp = `${opts.output}.${process.pid}.tmp`;
  const args = ['index', '-o', tmp, '--module-version=v0.0.0', '--quiet'];
  log.info('scip_go_start', { cwd, goflags: opts.env.GOFLAGS, timeoutMs: opts.timeoutMs });
  const started = Date.now();
  try {
    await checkGoPackages(opts, cwd, opts.timeoutMs);
    const remaining = Math.max(1, deadline - Date.now());
    const exit = await runProcess({ bin: opts.bin, args, cwd, timeoutMs: remaining, tmp, env: opts.env, signal: opts.signal });
    log.info('scip_go_exit', { code: exit.code, signal: exit.signal, timedOut: exit.timedOut, aborted: exit.aborted, ms: Date.now() - started });
    checkExit('scip-go', exit, opts.timeoutMs);
    await keepOutput('scip-go', tmp, opts.output, exit);
  } finally {
    await rm(tmp, { force: true });
  }
}

/** 运行 Rust 的命令；启动失败（程序或 cwd 不存在等）时改抛 ScipRunError，调用方按这次运行失败处理 */
async function runRustProcess(run: ProcessRun): Promise<ExitInfo> {
  try {
    return await runProcess(run);
  } catch (err) {
    throw new ScipRunError(`${path.basename(run.bin)} failed to start: ${(err as Error).message}`);
  }
}

export interface RustCommandOptions {
  /** 可执行文件的绝对路径 */
  bin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onStderr?: (line: string) => void;
}

/**
 * 运行 `cargo metadata` 检查包和依赖能否解析（输出丢弃）。offline 时加 `--offline`。
 * 被中止时抛出 ScipRunError；超时和退出码不为 0 时返回 ExitInfo 由调用方判断
 */
export async function runCargoMetadata(opts: RustCommandOptions & { offline: boolean }): Promise<ExitInfo> {
  if (opts.signal?.aborted) throw new ScipRunError('cargo metadata cancelled');
  const args = ['metadata', '--format-version', '1', '--all-features', ...(opts.offline ? ['--offline'] : [])];
  const started = Date.now();
  const exit = await runRustProcess({ ...opts, args });
  log.info('cargo_metadata_exit', { cwd: opts.cwd, offline: opts.offline, code: exit.code, timedOut: exit.timedOut, ms: Date.now() - started });
  if (exit.aborted) throw new ScipRunError('cargo metadata cancelled');
  return exit;
}

/** rust-analyzer scip 的运行参数；output 为索引文件，configPath 为 rust-analyzer 的 JSON 配置 */
export interface RustAnalyzerScipOptions extends RustCommandOptions {
  output: string;
  configPath: string;
}

/** 在 cwd 运行 `rust-analyzer scip .` 生成索引（文档路径相对 cwd）。先写临时文件，成功后再改名；失败、超时、中止时抛出 ScipRunError */
export async function runRustAnalyzerScip(opts: RustAnalyzerScipOptions): Promise<void> {
  if (opts.signal?.aborted) throw new ScipRunError('rust-analyzer cancelled');
  const tmp = `${opts.output}.${process.pid}.tmp`;
  const args = ['scip', '.', '--output', tmp, '--config-path', opts.configPath];
  log.info('rust_analyzer_scip_start', { cwd: opts.cwd, timeoutMs: opts.timeoutMs });
  const started = Date.now();
  try {
    const exit = await runRustProcess({ ...opts, args, tmp });
    log.info('rust_analyzer_scip_exit', { code: exit.code, signal: exit.signal, timedOut: exit.timedOut, aborted: exit.aborted, ms: Date.now() - started });
    checkExit('rust-analyzer', exit, opts.timeoutMs);
    await keepOutput('rust-analyzer', tmp, opts.output, exit);
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * 结束本进程启动的所有 SCIP 索引子进程（连同它们的进程组）并删除临时输出（serve / mcp 退出前调用，避免留下孤儿进程和 .tmp 文件）。
 * 返回结束的进程数；对应的构建会按解析失败处理。
 */
export async function killActiveScipProcesses(): Promise<number> {
  const runs = [...active.entries()];
  for (const [child] of runs) killGroup(child);
  await Promise.all(runs.map(async ([, run]) => {
    await run.closed;
    if (run.tmp) await rm(run.tmp, { force: true });
  }));
  if (runs.length > 0) log.info('scip_processes_killed', { count: runs.length });
  return runs.length;
}
