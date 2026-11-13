import { constants } from 'node:os';
import { flushOpencodeSessions, GitError, killActiveCliProcesses, ReviewArgsError } from '@codeinsight/core';
import { runAskCommand } from './commands/ask.js';
import { runIndex } from './commands/index.js';
import { runReviewCommand } from './commands/review.js';
import { runMcpCommand } from './commands/mcp.js';
import { runOverviewCommand } from './commands/overview.js';
import { runServeCommand } from './commands/serve.js';
import { runSimilarCommand } from './commands/similar.js';

const USAGE = `Usage: codeinsight <command> [options]

Commands:
  index     Build the index for the working tree or a commit
  review    Review changes between two versions
  similar   Find duplicate implementations
  overview  Generate a system overview (modules, dependencies, features, AI descriptions)
  ask       Ask a question about the code (needs an LLM)
  serve     Start the local web UI / HTTP API
  mcp       Start the MCP server over stdio
`;

const COMMANDS: Record<string, (argv: string[], signal: AbortSignal) => Promise<number>> = {
  index: runIndex,
  review: (argv, signal) => runReviewCommand(argv, { signal }),
  similar: runSimilarCommand,
  overview: runOverviewCommand,
  ask: runAskCommand,
  serve: (argv) => runServeCommand(argv),
  mcp: runMcpCommand,
};

/** 会启动本机 CLI 子进程的命令，由 runCli 统一处理退出信号；serve、mcp 自己处理关闭 */
const LLM_COMMANDS = new Set(['ask', 'overview', 'review']);
const STOP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

interface StopWatch {
  /** 收到信号时中止，命令可以用它提前结束（如 ask 输出已收到的部分） */
  signal: AbortSignal;
  /** 命令已自行返回，清理完成后不再强制退出 */
  finished: () => void;
  /** 收到过信号时的退出码（128 + 信号编号） */
  exitCode: () => number | undefined;
  dispose: () => void;
}

/**
 * 收到 SIGINT / SIGTERM / SIGHUP 时：中止命令，结束本机 CLI 子进程（连同它的进程组，删 opencode 会话的除外），
 * 等会话删完后结束剩下的子进程；命令到这时还没返回就直接退出。退出码都是 128 + 信号编号。CLI 子进程自成进程组，
 * 不这样处理时终端的 Ctrl-C 到不了它们，进程会继续运行并消耗账号额度。再收到一次信号时立即退出。
 */
function watchStopSignals(): StopWatch {
  const ac = new AbortController();
  let finished = false;
  let markFinished!: () => void;
  const done = new Promise<void>((r) => (markFinished = r));
  let exitCode: number | undefined;
  const onSignal = (sig: NodeJS.Signals): void => {
    const code = 128 + (constants.signals[sig] ?? 2);
    if (exitCode !== undefined) process.exit(code);
    exitCode = code;
    ac.abort();
    void stopCliProcesses()
      .then(() => waitAtMost(done, EXIT_GRACE_MS))
      .finally(() => {
        if (!finished) process.exit(code);
      });
  };
  for (const sig of STOP_SIGNALS) process.on(sig, onSignal);
  return {
    signal: ac.signal,
    exitCode: () => exitCode,
    finished: () => {
      finished = true;
      markFinished();
    },
    dispose: () => {
      for (const sig of STOP_SIGNALS) process.off(sig, onSignal);
    },
  };
}

/** 子进程结束后留给命令自行收尾（输出已收到的部分、写完 stdout）的时间 */
const EXIT_GRACE_MS = 2_000;

async function waitAtMost(p: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([p, new Promise((r) => (timer = setTimeout(r, ms)))]);
  clearTimeout(timer);
}

async function stopCliProcesses(): Promise<void> {
  await killActiveCliProcesses({ keepSessionDelete: true });
  // 让被结束的调用走完收尾，把 opencode 会话放进删除队列
  await new Promise((r) => setImmediate(r));
  await flushOpencodeSessions();
  await killActiveCliProcesses();
}

export async function runCli(argv: string[]): Promise<number> {
  const [command] = argv;
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    process.stderr.write(`unknown command: ${command}\n${USAGE}`);
    return 1;
  }
  const stop = LLM_COMMANDS.has(command) ? watchStopSignals() : undefined;
  try {
    const code = await handler(argv.slice(1), stop?.signal ?? new AbortController().signal);
    return stop?.exitCode() ?? code;
  } catch (err) {
    // 收到退出信号后中止的命令不输出结果，按信号退出码返回
    const stopped = stop?.exitCode();
    if (stopped !== undefined) {
      process.stderr.write(`codeinsight: ${command} cancelled\n`);
      return stopped;
    }
    // 参数错误和 git 错误按约定退出码 1
    const e = err as Error & { code?: string };
    if (err instanceof GitError || err instanceof ReviewArgsError || e.code?.startsWith('ERR_PARSE_ARGS')) {
      process.stderr.write(`error: ${e.message}\n`);
      return 1;
    }
    throw err;
  } finally {
    stop?.finished();
    // overview / ask / review 用 opencode 时留下的会话在命令结束前删掉（最多等 5 秒）
    await flushOpencodeSessions();
    stop?.dispose();
  }
}
