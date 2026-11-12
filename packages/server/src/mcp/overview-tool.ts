import { computeStructure, moduleMarkdown, overviewMarkdown, structureReport, truncateAtLine } from '@codeinsight/core';
import type { OverviewReport, SnapshotRow } from '@codeinsight/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { overviewStale } from '../jobs/overview-jobs.js';
import { ensureWorkspaceSnapshot, type McpContext } from './context.js';
import { runTool, textResult } from './tool-result.js';

/** 返回给 MCP 客户端的 Markdown 上限 */
export const MAX_OVERVIEW_CHARS = 30_000;

const inputSchema = {
  module: z.string().optional().describe('Module id (e.g. "server/modules/billing") or module name. Omit for the whole-system overview'),
};

interface LoadedOverview {
  report: OverviewReport;
  /** 来自已保存的概览；false 表示就地算出的结构部分 */
  saved: boolean;
  stale: boolean;
}

/** 当前概览；没有时就地算结构部分（不调用 LLM、只读划分记录不写、不写库） */
async function loadOverview(ctx: McpContext, snap: SnapshotRow): Promise<LoadedOverview> {
  const { repo, store, layout, config } = ctx.ws;
  const row = store.overviews.current('working').overview;
  if (row?.result) return { report: row.result, saved: true, stale: overviewStale(row, snap) };
  const s = await computeStructure({ repo, store, layout, config, snapshot: snap });
  return { report: structureReport(s, { repo, ref: 'working' }), saved: false, stale: false };
}

const omittedModulesNote = (n: number) => `其余 ${n} 个模块未列出，用 \`module\` 参数（模块 id 或名称）查看。`;

/** 过期提示放开头、“只有结构部分”的提示放末尾；正文按扣掉提示后的字数上限生成 */
function compose(o: LoadedOverview, body: (maxChars: number) => string): string {
  const head = o.stale ? [`> 注意：本概览生成于 ${new Date(o.report.generatedAt).toISOString()}，之后代码已有变化。`, ''] : [];
  const tail = o.saved ? [] : ['', '> 当前没有保存的概览，以上只有结构部分。运行 `codeinsight overview` 可加上 AI 生成的说明。'];
  const notes = [...head, ...tail].join('\n').length + 1;
  return [...head, body(MAX_OVERVIEW_CHARS - notes), ...tail].join('\n');
}

/** get_overview：系统概览或单个模块的详情（Markdown） */
export function registerOverviewTool(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'get_overview',
    {
      description: 'System overview of the repository: modules with responsibilities and dependencies, external services, features (HTTP APIs, jobs), and boundary issues. Pass `module` for one module\'s interfaces, models, external dependencies, environment variables, dependency call sites, features and issues.',
      inputSchema,
    },
    (args) =>
      runTool(ctx, 'get_overview', { module: args.module }, async () => {
        const snap = await ensureWorkspaceSnapshot(ctx);
        const o = await loadOverview(ctx, snap);
        if (args.module === undefined) return textResult(compose(o, (maxChars) => overviewMarkdown(o.report, { maxChars, omittedModulesNote })));
        const md = moduleMarkdown(o.report, args.module);
        if (md === undefined) {
          const ids = o.report.modules.map((m) => `\`${m.id}\` (${m.name})`).join(', ');
          return textResult(`No module \`${args.module}\`. Modules: ${ids}`, true);
        }
        return textResult(compose(o, (maxChars) => truncateAtLine(md, maxChars)));
      }),
  );
}
