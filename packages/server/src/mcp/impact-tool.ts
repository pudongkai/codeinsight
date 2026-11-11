import { traverse } from '@codeinsight/core';
import type { SnapshotRow, SymbolRow, TraverseResult } from '@codeinsight/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ensureWorkspaceSnapshot, type McpContext } from './context.js';
import { candidatesText, location, notFoundText, resolverNote } from './format.js';
import { lookupSymbol } from './lookup.js';
import { runTool, textResult } from './tool-result.js';

const MAX_DEPTH = 5;

const inputSchema = {
  symbol: z.string().min(1).describe('Function name, qualified name (Class.method) or symbol key'),
  depth: z.number().int().min(1).max(MAX_DEPTH).optional().describe('Levels of callers to follow (default 2)'),
};

function symbolLine(s: SymbolRow): string {
  return `- \`${s.qualifiedName}\` at ${location(s)}`;
}

/** 按层列出调用方，每层先正式代码后测试代码 */
function impactText(sym: SymbolRow, snap: SnapshotRow, r: TraverseResult, depth: number): string {
  const reached = [...r.reached.get(sym.id)!].map(([id, d]) => ({ s: r.symbols.get(id)!, d }));
  const prod = reached.filter((x) => !x.s.isTest).length;
  const lines = [
    `# Impact of \`${sym.qualifiedName}\` (${location(sym)})`, '',
    ...resolverNote(snap),
    `Callers via call and reference edges, up to ${depth} level(s): ${prod} production, ${reached.length - prod} test.`, '',
  ];
  for (let level = 1; level <= depth; level++) {
    const atLevel = reached.filter((x) => x.d === level).sort((a, b) => a.s.path.localeCompare(b.s.path) || a.s.startLine - b.s.startLine);
    if (atLevel.length === 0) continue;
    lines.push(`## Level ${level}`, '');
    for (const [label, group] of [['Production', atLevel.filter((x) => !x.s.isTest)], ['Test', atLevel.filter((x) => x.s.isTest)]] as const) {
      if (group.length > 0) lines.push(`### ${label} (${group.length})`, '', ...group.map((x) => symbolLine(x.s)), '');
    }
  }
  if (reached.length === 0) lines.push('No callers found.');
  return lines.join('\n');
}

/** get_impact：正式代码和测试代码调用方，按层列出；名字对应多个符号时返回候选列表 */
export function registerImpactTool(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'get_impact',
    { description: 'List the production and test callers of a function, level by level (impact of changing it).', inputSchema },
    (args) =>
      runTool(ctx, 'get_impact', { symbol: args.symbol, depth: args.depth }, async () => {
        const snap = await ensureWorkspaceSnapshot(ctx);
        const found = lookupSymbol(ctx.ws.store, snap.id, args.symbol);
        if (found.kind === 'not_found') return textResult(notFoundText(args.symbol), true);
        if (found.kind === 'ambiguous') return textResult(candidatesText(args.symbol, found.candidates));
        const depth = args.depth ?? ctx.ws.config.impactDepth;
        const r = traverse(ctx.ws.store, snap.id, [found.symbol.id], { direction: 'callers', depth });
        return textResult(impactText(found.symbol, snap, r, depth));
      }),
  );
}
