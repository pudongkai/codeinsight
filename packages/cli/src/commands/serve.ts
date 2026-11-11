import path from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { killActiveScipProcesses, log, ReviewArgsError } from '@codeinsight/core';
import type { Resolver } from '@codeinsight/core';
import { startHttpServer, type RunningHttpServer } from '@codeinsight/server';
import { openBrowser } from '../open-browser.js';
import { DEFAULT_STATIC_DIR } from '../web-assets.js';
import { openWorkspace } from './workspace.js';

export const SERVE_USAGE = `Usage: codeinsight serve [--repo .] [--port 0] [--open] [--data-dir DIR] [--exit-on-stdin-close]

Start the local web UI / HTTP API on 127.0.0.1 (random port by default).
Prints one JSON line to stdout: {"port":..,"token":"..","url":"..","repo":"..","dataDir":".."}
(repo and dataDir are absolute paths). --open opens the url in the default browser.
--exit-on-stdin-close shuts down like SIGTERM when stdin reaches EOF (for parent processes such as IDE plugins,
so serve does not outlive a parent that crashed or was killed).
`;

function parseServeArgs(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string', default: '.' },
      port: { type: 'string', default: '0' },
      open: { type: 'boolean' },
      'data-dir': { type: 'string' },
      'exit-on-stdin-close': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ReviewArgsError(`--port must be an integer between 0 and 65535: ${values.port}`);
  return { ...values, port };
}

export interface ServeDeps {
  openUrl?: (url: string) => void;
  staticDir?: string;
  /** 测试注入 */
  resolver?: Resolver;
}

export interface StartedServe {
  server: RunningHttpServer;
  /** 是否在 stdin 关闭时退出（--exit-on-stdin-close） */
  exitOnStdinClose: boolean;
  /** 停止服务并关闭数据库 */
  stop(opts?: { drain?: boolean }): Promise<void>;
}

/** 启动服务并在 stdout 输出一行 JSON；--help 时返回 undefined */
export async function startServe(argv: string[], deps: ServeDeps = {}): Promise<StartedServe | undefined> {
  const args = parseServeArgs(argv);
  if (args.help) {
    process.stdout.write(SERVE_USAGE);
    return undefined;
  }
  const ws = { ...(await openWorkspace(args.repo, args['data-dir'])), resolver: deps.resolver };
  const server = await startHttpServer({ workspace: ws, port: args.port, staticDir: deps.staticDir ?? DEFAULT_STATIC_DIR });
  const line = { port: server.port, token: server.token, url: server.url, repo: path.resolve(ws.repo), dataDir: path.resolve(ws.config.dataDir) };
  process.stdout.write(JSON.stringify(line) + '\n');
  if (args.open) (deps.openUrl ?? openBrowser)(server.url);
  return {
    server,
    exitOnStdinClose: args['exit-on-stdin-close'] === true,
    stop: async (opts) => {
      await server.close(opts);
      ws.store.close();
    },
  };
}

type StopReason = NodeJS.Signals | 'stdin_closed';

/**
 * 等到 SIGINT / SIGTERM；watchStdin 时 stdin 读到 EOF（父进程退出或崩溃时管道被关闭）也算退出信号。
 * 信号处理函数在开始退出后不摘掉、只忽略后续信号：摘掉后再来的 SIGTERM 会按 Node 默认行为直接结束进程，scip-python 子进程和临时文件就清理不到了。
 */
function waitForStop(watchStdin: boolean): Promise<StopReason> {
  return new Promise((resolve) => {
    let stopping = false;
    const done = (reason: StopReason) => {
      if (stopping) {
        log.info('serve_signal_ignored', { signal: reason });
        return;
      }
      stopping = true;
      if (watchStdin) process.stdin.pause();
      resolve(reason);
    };
    process.on('SIGINT', done);
    process.on('SIGTERM', done);
    if (watchStdin) {
      const closed = () => done('stdin_closed');
      process.stdin.once('end', closed);
      process.stdin.once('error', closed);
      // 输入内容不使用，只为读到 EOF
      process.stdin.on('data', () => undefined);
      process.stdin.resume();
    }
  });
}

/** 收到退出信号后最多等这么久让被中断的任务写回状态 */
const SHUTDOWN_GRACE_MS = 3000;

/**
 * codeinsight serve：运行到收到 SIGINT / SIGTERM（或 --exit-on-stdin-close 时 stdin 关闭）。退出时先结束正在跑的 scip-python 子进程（不留孤儿进程和临时文件），
 * 稍等被中断的任务写回状态（解析标为失败），然后结束进程；仍在跑的审查在下次启动时标为 failed。
 */
export async function runServeCommand(argv: string[], deps: ServeDeps = {}): Promise<number> {
  const started = await startServe(argv, deps);
  if (!started) return 0;
  const reason = await waitForStop(started.exitOnStdinClose);
  log.info('serve_stopping', { signal: reason });
  const killed = await killActiveScipProcesses();
  await Promise.race([started.server.close({ drain: true }), sleep(SHUTDOWN_GRACE_MS)]);
  log.info('serve_stopped', { killedScip: killed });
  process.exit(0);
}
