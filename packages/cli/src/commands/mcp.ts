import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ReviewArgsError, type AskToolServer } from '@codeinsight/core';
import { askToolContext, AskToolsSnapshotError, runAskToolsMcpStdio, runMcpStdio } from '@codeinsight/server';
import { openWorkspace, type Workspace } from './workspace.js';

export const MCP_USAGE = `Usage: codeinsight mcp [--repo .] [--data-dir DIR]

Run the MCP server over stdio. Tools: review_changes, get_impact, find_similar, get_overview.
--ask-tools is used internally by ask.
`;

/** cli 入口（构建后的 main.js） */
const CLI_ENTRY = fileURLToPath(new URL('../main.js', import.meta.url));

/** 本机 CLI 问答用的工具服务启动命令，serve 和 ask 传给问答流程 */
export function askToolServer(): AskToolServer {
  return { command: process.execPath, args: [CLI_ENTRY, 'mcp', '--ask-tools'] };
}

function positiveInt(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new ReviewArgsError(`--${name} must be a positive integer: ${raw}`);
  return n;
}

interface AskToolsArgs {
  snapshot?: string;
  'no-source'?: boolean;
  'max-tool-chars'?: string;
}

/** `mcp --ask-tools`：只提供 7 个问答工具，绑定 --snapshot 指定的快照；快照不存在或没建好时退出码 1 */
async function runAskToolsServer(ws: Workspace, values: AskToolsArgs): Promise<number> {
  const snapshotId = positiveInt('snapshot', values.snapshot);
  if (snapshotId === undefined) throw new ReviewArgsError('--ask-tools needs --snapshot');
  const maxToolChars = positiveInt('max-tool-chars', values['max-tool-chars']) ?? ws.config.ask.maxToolChars;
  let ctx;
  try {
    ctx = askToolContext(ws, snapshotId, values['no-source'] !== true);
  } catch (err) {
    if (!(err instanceof AskToolsSnapshotError)) throw err;
    process.stderr.write(`error: ${err.message}\n`);
    return 1;
  }
  await runAskToolsMcpStdio(ctx, { maxToolChars });
  return 0;
}

/** codeinsight mcp：stdio MCP 服务，客户端断开后退出 */
export async function runMcpCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string', default: '.' },
      'data-dir': { type: 'string' },
      'ask-tools': { type: 'boolean' },
      snapshot: { type: 'string' },
      'no-source': { type: 'boolean' },
      'max-tool-chars': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(MCP_USAGE);
    return 0;
  }
  const ws = await openWorkspace(values.repo, values['data-dir']);
  try {
    if (values['ask-tools']) return await runAskToolsServer(ws, values);
    await runMcpStdio({ workspace: ws });
    return 0;
  } finally {
    ws.store.close();
  }
}
