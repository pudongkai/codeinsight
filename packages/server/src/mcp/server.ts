import { setTimeout as sleep } from 'node:timers/promises';
import { killActiveCliProcesses, killActiveScipProcesses, log } from '@codeinsight/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { IndexJobs } from '../jobs/index-jobs.js';
import { PendingSet } from '../jobs/pending.js';
import type { ServerWorkspace } from '../workspace.js';
import { DEFAULT_INDEX_TIMEOUT_MS, type McpContext } from './context.js';
import { registerImpactTool } from './impact-tool.js';
import { registerOverviewTool } from './overview-tool.js';
import { registerReviewTool } from './review-tool.js';
import { registerSimilarTool } from './similar-tool.js';

export const SERVER_VERSION = '0.1.0';

export interface McpOptions {
  workspace: ServerWorkspace;
  /** 没有可复用快照时同步建索引的最长等待，默认 300s */
  indexTimeoutMs?: number;
}

function buildServer(opts: McpOptions): { server: McpServer; ctx: McpContext } {
  const server = new McpServer({ name: 'codeinsight', version: SERVER_VERSION });
  const ws = opts.workspace;
  const ctx: McpContext = { ws, indexJobs: new IndexJobs(ws), indexTimeoutMs: opts.indexTimeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS, pending: new PendingSet() };
  registerReviewTool(server, ctx);
  registerImpactTool(server, ctx);
  registerSimilarTool(server, ctx);
  registerOverviewTool(server, ctx);
  return { server, ctx };
}

/** MCP 服务：审查相关的 review_changes、get_impact、find_similar，以及系统概览 get_overview */
export function createMcpServer(opts: McpOptions): McpServer {
  return buildServer(opts).server;
}

/**
 * 在 stdio 上运行 MCP 服务，客户端断开（stdin 结束）后返回。stdout 只用于协议消息，日志写 stderr。
 * 断开时结束正在跑的 scip-python 和本机 CLI 子进程，并等建索引和工具调用结束（被中断的快照标为解析失败，下次按重试逻辑恢复），
 * 返回后调用方才能安全关库。
 */
export async function runMcpStdio(opts: McpOptions): Promise<void> {
  const { server, ctx } = buildServer(opts);
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
  process.stdin.once('end', () => void server.close());
  await server.connect(new StdioServerTransport());
  log.info('mcp_started', { repo: opts.workspace.repo });
  await closed;
  log.info('mcp_closed', { killedScip: await stopWork(ctx) });
}

/**
 * 结束 scip-python 和 CLI 子进程并等进行中的工作结束；工具调用可能在这期间又启动子进程，所以反复结束直到全部完成。
 * 删 opencode 会话的命令照常放行，命令退出前还要删会话。
 */
async function stopWork(ctx: McpContext): Promise<number> {
  let finished = false;
  const settled = Promise.allSettled([ctx.indexJobs.drain(), ctx.pending.drain()]).then(() => {
    finished = true;
  });
  let killed = 0;
  while (!finished) {
    const [scip] = await Promise.all([killActiveScipProcesses(), killActiveCliProcesses({ keepSessionDelete: true })]);
    killed += scip;
    await Promise.race([settled, sleep(200)]);
  }
  return killed;
}
