import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
export const CLI_MAIN = path.join(ROOT, 'packages', 'cli', 'dist', 'main.js');
const FIXTURE = path.join(ROOT, 'packages', 'core', 'test', 'fixtures', 'py-basic');
const SHOP_FIXTURE = path.join(ROOT, 'packages', 'core', 'test', 'fixtures', 'py-shop');

/**
 * 假的 claude 命令：应答测试连接（--version、auth status、单次调用），问答时连上 codeinsight 的工具服务调用工具后回答。
 * serve 通过 CODEINSIGHT_LLM_COMMAND 使用它，不调用真实的 Claude Code。
 */
export function fakeClaudeCommand(): string {
  const file = path.join(ROOT, 'packages', 'server', 'test', 'helpers', 'fake-claude-mcp.mjs');
  chmodSync(file, 0o755);
  return file;
}

export function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/**
 * 子进程环境：去掉 LLM 相关变量，测试不会调用真实 LLM，也不读本机 API key；
 * 每次调用建一个新的临时 CODEINSIGHT_HOME，不读写本机用户设置，各个 serve 的设置和最近列表互不影响
 */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CODEINSIGHT_|ANTHROPIC_|OPENAI_)/.test(k)) env[k] = v;
  return { ...env, CODEINSIGHT_LOG: 'warn', CODEINSIGHT_HOME: tempDir('ci-e2e-home-') };
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
  const repo = committedCopy(FIXTURE);
  writeFileSync(path.join(repo, 'pkg', 'repo.py'), CHANGED_REPO_PY);
  return repo;
}

/** 把 fixtures 目录复制到临时目录，extra 里的文件一并写入，作为第一个提交 */
function committedCopy(fixture: string, extra: Record<string, string> = {}): string {
  if (!existsSync(CLI_MAIN)) throw new Error(`${CLI_MAIN} is missing; run pnpm -r build first`);
  const repo = tempDir('ci-e2e-repo-');
  cpSync(fixture, repo, { recursive: true });
  for (const [rel, text] of Object.entries(extra)) writeFileSync(path.join(repo, rel), text);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

/**
 * py-shop 仓库（概览用）：阈值调小（同 server 测试的 shopRepo），模块划分为
 * `*`、`app/*`、`app/big#a`、`app/big#c`、`app/common`、`app/leaf`、`app/orders`、`app/payments`、`app/users`。
 */
export function shopRepo(): string {
  return committedCopy(SHOP_FIXTURE, {
    'codeinsight.config.json': JSON.stringify({ overview: { moduleMinSize: 3, moduleMaxSize: 15, leafSplitSize: 8 } }),
  });
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

/**
 * 以 `codeinsight serve --open` 启动（打开浏览器的动作由 serve-open.mjs 替换），读 stdout 拿到地址。
 * 子进程环境为 cleanEnv() 加上 env（如假 LLM 的 fakeLlmEnv(url)，或指定 CODEINSIGHT_HOME）；cwd 为子进程的当前目录。
 */
async function spawnServe(args: string[], env: Record<string, string>, cwd?: string): Promise<Serve> {
  const proc = spawn(process.execPath, [SERVE_OPEN, ...args], { cwd, env: { ...cleanEnv(), ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
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

export function startServe(repo: string, dataDir: string, env: Record<string, string> = {}): Promise<Serve> {
  return spawnServe(['--repo', repo, '--data-dir', dataDir], env);
}

/** 不带 --repo，在 cwd 下启动；cwd 不在 git 仓库里时 serve 以“无仓库”启动 */
export function startServeIn(cwd: string, env: Record<string, string> = {}): Promise<Serve> {
  return spawnServe([], env, cwd);
}

/** 运行 cli 命令（同步），返回 stdout */
export function runCli(args: string[]): string {
  return execFileSync(process.execPath, [CLI_MAIN, ...args], { env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}
