import { GitError } from '@codeinsight/core';
import { runIndex } from './commands/index.js';

const USAGE = `Usage: codeinsight <command> [options]

Commands:
  index     Build the index for the working tree or a commit
  review    Review changes between two versions
  similar   Find duplicate implementations
  serve     Start the local web UI / HTTP API
  mcp       Start the MCP server over stdio
`;

const COMMANDS: Record<string, (argv: string[]) => Promise<number>> = {
  index: runIndex,
};

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
  try {
    return await handler(argv.slice(1));
  } catch (err) {
    // 参数错误和 git 错误按约定退出码 1
    const e = err as Error & { code?: string };
    if (err instanceof GitError || e.code?.startsWith('ERR_PARSE_ARGS')) {
      process.stderr.write(`error: ${e.message}\n`);
      return 1;
    }
    throw err;
  }
}
