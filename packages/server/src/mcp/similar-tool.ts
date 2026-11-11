import { FUNCTION_KINDS, similarInSnapshot, similarToCode } from '@codeinsight/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ensureWorkspaceSnapshot, type McpContext } from './context.js';
import { candidatesText, location, notFoundText, similarText } from './format.js';
import { lookupSymbol } from './lookup.js';
import { runTool, textResult } from './tool-result.js';

const inputSchema = {
  symbol: z.string().min(1).optional().describe('Existing function: name, qualified name (Class.method) or symbol key'),
  code: z.string().min(1).optional().describe('Python code not yet written to the repo (one or more functions, or a function body)'),
};

async function bySymbol(ctx: McpContext, query: string): Promise<CallToolResult> {
  const snap = await ensureWorkspaceSnapshot(ctx);
  const found = lookupSymbol(ctx.ws.store, snap.id, query);
  if (found.kind === 'not_found') return textResult(notFoundText(query), true);
  if (found.kind === 'ambiguous') return textResult(candidatesText(query, found.candidates));
  const sym = found.symbol;
  if (!FUNCTION_KINDS.has(sym.kind)) return textResult(`\`${sym.qualifiedName}\` is a ${sym.kind}, not a function or method.`, true);
  const minScore = ctx.ws.config.similarMinScore;
  const { findings } = similarInSnapshot(ctx.ws.store, snap.id, { queryIds: [sym.id], minScore });
  return textResult(similarText(`# Functions similar to \`${sym.qualifiedName}\` (${location(sym)})`, findings, minScore));
}

async function byCode(ctx: McpContext, code: string): Promise<CallToolResult> {
  const snap = await ensureWorkspaceSnapshot(ctx);
  const minScore = ctx.ws.config.similarMinScore;
  const { findings, queries } = await similarToCode(ctx.ws.store, snap.id, code, { minScore });
  const names = queries.map((q) => `\`${q.qualifiedName}\``).join(', ');
  return textResult(similarText(`# Existing functions similar to the given code (${names})`, findings, minScore));
}

/** find_similar：已有函数或一段新代码的重复实现候选，供写代码前查重 */
export function registerSimilarTool(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'find_similar',
    {
      description: 'Find existing functions that look like duplicates of a given function or of a code snippet you are about to write. Pass exactly one of symbol or code.',
      inputSchema,
    },
    (args) =>
      runTool(ctx, 'find_similar', { symbol: args.symbol, codeChars: args.code?.length }, async () => {
        if ((args.symbol === undefined) === (args.code === undefined)) return textResult('Error: pass exactly one of symbol or code', true);
        return args.symbol !== undefined ? bySymbol(ctx, args.symbol) : byCode(ctx, args.code!);
      }),
  );
}
