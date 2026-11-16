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
}

interface ActiveRun {
  /** 输出的临时文件 */
  tmp: string;
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
  /** 输出的临时文件，被强制结束时删除 */
  tmp: string;
  /** 不传时继承当前进程的环境变量 */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/** 在单独的进程组里运行一个索引命令并等它结束；超时或中止时结束整组。不因退出码抛错，结果在返回值里 */
export function runProcess(run: ProcessRun): Promise<ExitInfo> {
  return new Promise((resolve, reject) => {
    const child = spawn(run.bin, run.args, {
      cwd: run.cwd, env: run.env, stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
    });
    active.set(child, { tmp: run.tmp, closed: new Promise((r) => child.once('close', () => r())) });
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-64 * 1024);
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
      resolve({ code, signal, timedOut, aborted, stderr });
    });
  });
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
    if (exit.aborted) throw new ScipRunError('scip-python cancelled');
    if (exit.timedOut) throw new ScipRunError(`scip-python timed out after ${opts.timeoutMs}ms\n${tail(exit.stderr)}`);
    if (exit.code !== 0) throw new ScipRunError(`scip-python exited with code ${exit.code ?? exit.signal}\n${tail(exit.stderr)}`);
    const size = (await stat(tmp).catch(() => undefined))?.size ?? 0;
    if (size === 0) throw new ScipRunError(`scip-python produced no output\n${tail(exit.stderr)}`);
    await rename(tmp, opts.output);
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
    await rm(run.tmp, { force: true });
  }));
  if (runs.length > 0) log.info('scip_python_killed', { count: runs.length });
  return runs.length;
}
