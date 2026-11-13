import { ASK_TOOLS, currentOverview, log, runAskTool, TOOL_LIMIT_RESULT, truncateToolResult } from '@codeinsight/core';
import type { AskToolContext } from '@codeinsight/core';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PendingSet } from '../jobs/pending.js';
import type { ServerWorkspace } from '../workspace.js';
import { SERVER_VERSION } from './server.js';
import { textResult } from './tool-result.js';

/** 指定的快照不存在或还没建好 */
export class AskToolsSnapshotError extends Error {}

/** 问答工具的执行环境：绑定指定快照和它对应的当前概览，不建索引 */
export function askToolContext(ws: ServerWorkspace, snapshotId: number, sendSource: boolean): AskToolContext {
  const snapshot = ws.store.getSnapshot(snapshotId);
  if (!snapshot) throw new AskToolsSnapshotError(`snapshot ${snapshotId} does not exist`);
  if (snapshot.extractStatus !== 'ok') throw new AskToolsSnapshotError(`snapshot ${snapshotId} is not ready`);
  const overview = currentOverview(ws.store, snapshot);
  return { repo: ws.repo, store: ws.store, layout: ws.layout, snapshot, sendSource, ...(overview ? { overview } : {}) };
}

export interface AskToolsMcpOptions {
  /** 累计结果字符超过它之后，后续调用直接返回 TOOL_LIMIT_RESULT */
  maxToolChars: number;
  /** 最多执行的调用次数，不传时不限 */
  maxCalls?: number;
}

export interface AskToolsStats {
  calls: number;
  toolChars: number;
  /** 因上限没有执行的调用 */
  limited: number;
}

export interface AskToolsServer {
  server: Server;
  stats: AskToolsStats;
  /** 正在执行的调用，关闭时等它们结束 */
  pending: PendingSet;
}

const TOOLS = ASK_TOOLS.map((t) => ({
  name: t.name, description: t.description, inputSchema: t.inputSchema as { type: 'object'; [k: string]: unknown },
  annotations: { readOnlyHint: true, openWorldHint: false },
}));

async function callTool(ctx: AskToolContext, opts: AskToolsMcpOptions, stats: AskToolsStats, name: string, args: unknown): Promise<CallToolResult> {
  stats.calls++;
  if (stats.toolChars > opts.maxToolChars || (opts.maxCalls !== undefined && stats.calls > opts.maxCalls)) {
    stats.limited++;
    log.warn('ask_tool_limit', { tool: name, calls: stats.calls, toolChars: stats.toolChars, maxToolChars: opts.maxToolChars, maxCalls: opts.maxCalls });
    return textResult(TOOL_LIMIT_RESULT, true);
  }
  const started = Date.now();
  const out = await runAskTool(ctx, name, args ?? {});
  const text = truncateToolResult(out.content);
  stats.toolChars += text.length;
  log.info('ask_tool', { tool: name, args: JSON.stringify(args ?? {}).slice(0, 200), resultChars: text.length, ms: Date.now() - started, error: out.error });
  return textResult(text, out.error !== undefined);
}

/** 只含 7 个问答工具的 MCP 服务：名字、描述、参数 schema 直接用 ASK_TOOLS，执行用 runAskTool */
export function createAskToolsServer(ctx: AskToolContext, opts: AskToolsMcpOptions): AskToolsServer {
  const server = new Server({ name: 'codeinsight', version: SERVER_VERSION }, { capabilities: { tools: {} } });
  const stats: AskToolsStats = { calls: 0, toolChars: 0, limited: 0 };
  const pending = new PendingSet();
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, (req) => pending.track(callTool(ctx, opts, stats, req.params.name, req.params.arguments)));
  return { server, stats, pending };
}

/** 在 stdio 上运行问答工具服务，客户端断开（stdin 结束）后等进行中的调用结束再返回，调用方随后关库 */
export async function runAskToolsMcpStdio(ctx: AskToolContext, opts: AskToolsMcpOptions): Promise<void> {
  const { server, stats, pending } = createAskToolsServer(ctx, opts);
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });
  process.stdin.once('end', () => void server.close());
  await server.connect(new StdioServerTransport());
  log.info('ask_tools_mcp_started', { snapshot: ctx.snapshot.id, sendSource: ctx.sendSource, overview: ctx.overview !== undefined, maxToolChars: opts.maxToolChars, maxCalls: opts.maxCalls });
  await closed;
  await pending.drain();
  log.info('ask_tools_mcp_closed', { ...stats });
}
