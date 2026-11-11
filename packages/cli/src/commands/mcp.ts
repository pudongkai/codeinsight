import { parseArgs } from 'node:util';
import { runMcpStdio } from '@codeinsight/server';
import { openWorkspace } from './workspace.js';

export const MCP_USAGE = `Usage: codeinsight mcp [--repo .] [--data-dir DIR]

Run the MCP server over stdio. Tools: review_changes, get_impact, find_similar.
`;

/** codeinsight mcp：stdio MCP 服务，客户端断开后退出 */
export async function runMcpCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string', default: '.' },
      'data-dir': { type: 'string' },
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
    await runMcpStdio({ workspace: ws });
    return 0;
  } finally {
    ws.store.close();
  }
}
