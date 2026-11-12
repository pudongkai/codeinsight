import { log } from '@codeinsight/core';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpContext } from './context.js';

export function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/** 统一记录工具调用和耗时并登记为进行中；异常转成 isError 的文本结果，不让 MCP 客户端只看到协议错误 */
export function runTool(ctx: McpContext, tool: string, fields: Record<string, unknown>, fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  return ctx.pending.track(execute(tool, fields, fn));
}

async function execute(tool: string, fields: Record<string, unknown>, fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  const started = Date.now();
  log.info('mcp_tool_call', { tool, ...fields });
  let result: CallToolResult;
  try {
    result = await fn();
  } catch (err) {
    log.warn('mcp_tool_error', { tool, error: (err as Error).message });
    result = textResult(`Error: ${(err as Error).message}`, true);
  }
  log.info('mcp_tool_done', { tool, isError: result.isError === true, ms: Date.now() - started });
  return result;
}
