import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
export const CLI_MAIN = path.join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const FIXTURE = path.join(ROOT, 'packages', 'core', 'test', 'fixtures', 'py-basic');

export function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** 子进程环境：去掉 LLM 相关变量，测试不会调用真实 LLM，也不读本机 API key */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CODEINSIGHT_|ANTHROPIC_|OPENAI_)/.test(k)) env[k] = v;
  return { ...env, CODEINSIGHT_LOG: 'warn' };
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};

function git(repo: string, ...args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], { env: { ...process.env, ...GIT_ENV } });
}

const CHANGED_REPO_PY =
  'import os\n\n\ndef f(x):\n    """Join a path."""\n    return os.path.join("a", str(x))\n\n\ndef g():\n    return f(1) + f(2)\n\n\n' +
  'def k(items):\n    return [f(i) for i in items]\n\n\ndef rec(n):\n    return rec(n - 1) if n else 0\n\n\nclass Base:\n    pass\n';

/**
 * fixtures 仓库：py-basic 作为第一个提交；工作区里修改 g、新增调用 f 的 k（未提交），用于工作区审查。
 * 工作区里 f 的调用方：g、k、use、Service.helper 里的 inner、pkg.service 模块顶层代码，以及测试 test_f。
 */
export function fixtureRepo(): string {
  if (!existsSync(CLI_MAIN)) throw new Error(`${CLI_MAIN} is missing; run pnpm -r build first`);
  const repo = tempDir('ci-e2e-repo-');
  cpSync(FIXTURE, repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  writeFileSync(path.join(repo, 'pkg', 'repo.py'), CHANGED_REPO_PY);
  return repo;
}

export interface Serve {
  /** serve 输出的地址（带 token） */
  url: string;
  /** --open 交给浏览器打开的地址 */
  opened: string;
  port: number;
  proc: ChildProcess;
  stop(): Promise<void>;
}

const SERVE_OPEN = path.join(import.meta.dirname, 'serve-open.mjs');

function readLines(proc: ChildProcess, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    const rl = createInterface({ input: proc.stdout! });
    rl.on('line', (line) => {
      lines.push(line);
      if (lines.length === count) resolve(lines);
    });
    proc.once('exit', (code) => reject(new Error(`serve exited early with code ${code}`)));
  });
}

/** 以 `codeinsight serve --open` 启动（打开浏览器的动作由 serve-open.mjs 替换），读 stdout 拿到地址 */
export async function startServe(repo: string, dataDir: string): Promise<Serve> {
  const proc = spawn(process.execPath, [SERVE_OPEN, '--repo', repo, '--data-dir', dataDir], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'inherit'] });
  const [first, second] = await readLines(proc, 2);
  const info = JSON.parse(first!) as { url: string; port: number };
  const { opened } = JSON.parse(second!) as { opened: string };
  const stop = async () => {
    if (proc.exitCode !== null) return;
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill('SIGTERM');
    await exited;
  };
  return { url: info.url, port: info.port, opened, proc, stop };
}

/** 运行 cli 命令（同步），返回 stdout */
export function runCli(args: string[]): string {
  return execFileSync(process.execPath, [CLI_MAIN, ...args], { env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}
