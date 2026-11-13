import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { realDirOrUndefined, ReviewArgsError, type AskToolServer, type WriteToolsContext } from '@codeinsight/core';
import { askToolContext, AskToolsSnapshotError, runAskToolsMcpStdio, runMcpStdio } from '@codeinsight/server';
import { openWorkspace, type Workspace } from './workspace.js';

export const MCP_USAGE = `Usage: codeinsight mcp [--repo .] [--data-dir DIR]

Run the MCP server over stdio. Tools: review_changes, get_impact, find_similar, get_overview.
--write-tools and --writable-dir DIR (repeatable) add the two proposal tools to --ask-tools;
serve passes the directories it already checked for --add-dir, and --session ID so that new
proposals merge with the pending ones of the same chat session.
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
  'write-tools'?: boolean;
  'writable-dir'?: string[];
  session?: string;
}

/**
 * --write-tools 时的写入环境。目录由 serve 按 --add-dir 的规则检查后传进来，这里只取真实路径并确认还是目录；
 * 写入路径的检查（数据目录、禁止的目录名、符号链接）在写工具里照常做
 */
async function writeContext(values: AskToolsArgs): Promise<WriteToolsContext | undefined> {
  const dirs = values['writable-dir'] ?? [];
  if (!values['write-tools']) {
    if (dirs.length > 0 || values.session !== undefined) throw new ReviewArgsError('--writable-dir and --session need --write-tools');
    return undefined;
  }
  const real: string[] = [];
  for (const d of dirs) {
    const r = await realDirOrUndefined(d);
    if (!r) throw new ReviewArgsError(`--writable-dir ${d}: not an existing directory`);
    real.push(r);
  }
  const sessionId = positiveInt('session', values.session);
  return { dirs: real, ...(sessionId !== undefined ? { sessionId } : {}) };
}

/** `mcp --ask-tools`：提供 7 个查询工具（--write-tools 时加两个写工具），绑定 --snapshot 指定的快照；快照不存在或没建好时退出码 1 */
async function runAskToolsServer(ws: Workspace, values: AskToolsArgs): Promise<number> {
  const snapshotId = positiveInt('snapshot', values.snapshot);
  if (snapshotId === undefined) throw new ReviewArgsError('--ask-tools needs --snapshot');
  const maxToolChars = positiveInt('max-tool-chars', values['max-tool-chars']) ?? ws.config.ask.maxToolChars;
  const write = await writeContext(values);
  let ctx;
  try {
    ctx = askToolContext(ws, snapshotId, values['no-source'] !== true, write);
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
      'write-tools': { type: 'boolean' },
      'writable-dir': { type: 'string', multiple: true },
      session: { type: 'string' },
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
