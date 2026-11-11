import { spawn } from 'node:child_process';
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
}

export class ScipRunError extends Error {}

export function defaultScipPythonBin(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve('@sourcegraph/scip-python/package.json')), 'index.js');
}

function tail(text: string): string {
  return text.trimEnd().split('\n').slice(-STDERR_TAIL_LINES).join('\n');
}

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stderr: string;
}

function runProcess(args: string[], cwd: string, timeoutMs: number): Promise<ExitInfo> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-64 * 1024);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stderr });
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
  log.info('scip_python_start', { args: args.slice(1), timeoutMs: opts.timeoutMs });
  const started = Date.now();
  try {
    const exit = await runProcess(args, cwd, opts.timeoutMs);
    log.info('scip_python_exit', { code: exit.code, signal: exit.signal, timedOut: exit.timedOut, ms: Date.now() - started });
    if (exit.timedOut) throw new ScipRunError(`scip-python timed out after ${opts.timeoutMs}ms\n${tail(exit.stderr)}`);
    if (exit.code !== 0) throw new ScipRunError(`scip-python exited with code ${exit.code ?? exit.signal}\n${tail(exit.stderr)}`);
    const size = (await stat(tmp).catch(() => undefined))?.size ?? 0;
    if (size === 0) throw new ScipRunError(`scip-python produced no output\n${tail(exit.stderr)}`);
    await rename(tmp, opts.output);
  } finally {
    await rm(tmp, { force: true });
  }
}
