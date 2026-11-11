import { log, reportToMarkdown, runReview } from '@codeinsight/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpContext } from './context.js';
import { runTool, textResult } from './tool-result.js';

const inputSchema = {
  base: z.string().optional().describe('Base ref. Default: HEAD when reviewing the working tree, otherwise <head>~1'),
  head: z.string().optional().describe('Head commit ref. Omit to review uncommitted changes in the working tree'),
  working: z.boolean().optional().describe('Review uncommitted changes (default when head is omitted). Set false without head to review the HEAD commit'),
  intent: z.string().optional().describe('Task description to check the changes against (needs an LLM configured); defaults to the commit messages of the range'),
};

/** review_changes：审查报告的 Markdown（按模块的改动清单、调用方、重复候选、意图偏离、警告） */
export function registerReviewTool(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'review_changes',
    {
      description: 'Structural review of code changes: changed functions grouped by module with production/test caller counts, edge changes, possible duplicate implementations, intent check and warnings.',
      inputSchema,
    },
    (args) =>
      runTool(ctx, 'review_changes', { base: args.base, head: args.head, working: args.working, intentChars: args.intent?.length }, async () => {
        if (args.head !== undefined && args.working) return textResult('Error: head and working cannot be used together', true);
        const { repo, store, layout, config, resolver } = ctx.ws;
        const report = await runReview({
          repo, store, layout, config, resolver, base: args.base, head: args.head, working: args.working,
          intent: args.intent !== undefined ? { source: 'arg', text: args.intent } : undefined,
          onLlmNotice: (message) => log.info('llm_notice', { message }),
        });
        return textResult(reportToMarkdown(report));
      }),
  );
}
