import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { killActiveScipProcesses, log, ReviewArgsError } from '@codeinsight/core';
import type { Resolver } from '@codeinsight/core';
import { startHttpServer, type RunningHttpServer } from '@codeinsight/server';
import { openBrowser } from '../open-browser.js';
import { DEFAULT_STATIC_DIR } from '../web-assets.js';
import { openWorkspace } from './workspace.js';

export const SERVE_USAGE = `Usage: codeinsight serve [--repo .] [--port 0] [--open] [--data-dir DIR]

Start the local web UI / HTTP API on 127.0.0.1 (random port by default).
Prints one JSON line to stdout: {"port":..,"token":"..","url":".."}. --open opens the url in the default browser.
`;

function parseServeArgs(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string', default: '.' },
      port: { type: 'string', default: '0' },
      open: { type: 'boolean' },
      'data-dir': { type: 'string' },
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
  process.stdout.write(JSON.stringify({ port: server.port, token: server.token, url: server.url }) + '\n');
  if (args.open) (deps.openUrl ?? openBrowser)(server.url);
  return {
    server,
    stop: async (opts) => {
      await server.close(opts);
      ws.store.close();
    },
  };
}

function waitForSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const on = (sig: NodeJS.Signals) => {
      process.off('SIGINT', on);
      process.off('SIGTERM', on);
      resolve(sig);
    };
    process.on('SIGINT', on);
    process.on('SIGTERM', on);
  });
}

/** 收到退出信号后最多等这么久让被中断的任务写回状态 */
const SHUTDOWN_GRACE_MS = 3000;

/**
 * codeinsight serve：运行到收到 SIGINT / SIGTERM。退出时先结束正在跑的 scip-python 子进程（不留孤儿进程和临时文件），
 * 稍等被中断的任务写回状态（解析标为失败），然后结束进程；仍在跑的审查在下次启动时标为 failed。
 */
export async function runServeCommand(argv: string[], deps: ServeDeps = {}): Promise<number> {
  const started = await startServe(argv, deps);
  if (!started) return 0;
  const sig = await waitForSignal();
  log.info('serve_stopping', { signal: sig });
  const killed = await killActiveScipProcesses();
  await Promise.race([started.server.close({ drain: true }), sleep(SHUTDOWN_GRACE_MS)]);
  log.info('serve_stopped', { killedScip: killed });
  process.exit(0);
}
