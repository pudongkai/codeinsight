import { parseArgs } from 'node:util';
import {
  buildSnapshot, estimateOverview, log, OverviewRunningError, overviewMarkdown, ReviewArgsError, startOverview,
} from '@codeinsight/core';
import type { OverviewEstimate, OverviewOptions } from '@codeinsight/core';
import { writeTextOutput } from './output.js';
import { openWorkspace } from './workspace.js';

export const OVERVIEW_USAGE = `Usage: codeinsight overview [--repo .] [--ref REF] [--data-dir DIR]
                            [--no-llm] [--no-source] [--estimate] [--yes]
                            [--format json|md] [--out PATH]

Generate a system overview: modules, dependencies, external services, features and boundary issues,
plus AI-written names and descriptions when an LLM is configured (CODEINSIGHT_LLM_PROVIDER).
Without --ref, uses the working tree.
--no-llm     send no requests; descriptions already in the LLM cache are still used
--no-source  do not send source snippets to the LLM
--estimate   only print the estimated number of requests and tokens; nothing is sent or saved
--yes        generate even when the estimated input tokens exceed overview.confirmTokens
             (without it the estimate is printed to stderr and the exit code is 2)
Exit codes: 0 success; 1 bad arguments, git error, or another overview is running; 2 confirmation (--yes) needed.
`;

const FORMATS = ['json', 'md'] as const;
type Format = (typeof FORMATS)[number];

function parseOverviewArgs(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string', default: '.' },
      ref: { type: 'string' },
      'data-dir': { type: 'string' },
      'no-llm': { type: 'boolean' },
      'no-source': { type: 'boolean' },
      estimate: { type: 'boolean' },
      yes: { type: 'boolean' },
      format: { type: 'string', default: 'json' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (!FORMATS.includes(values.format as Format)) throw new ReviewArgsError(`unsupported --format: ${values.format} (expected json or md)`);
  return { ...values, format: values.format as Format };
}

type OverviewArgs = ReturnType<typeof parseOverviewArgs>;

function estimateMarkdown(e: OverviewEstimate): string {
  return [
    '# CodeInsight overview estimate', '',
    `- Modules: ${e.modules}`,
    `- LLM: ${e.provider ? `${e.provider} (${e.model})` : 'not configured'}; source snippets: ${e.sendSource ? 'sent' : 'not sent'}`,
    `- Requests to send: ${e.llmCalls}; cached: ${e.cachedCalls}`,
    `- Estimated tokens: ${e.inputTokens} input, up to ${e.outputTokens} output`,
    `- Needs confirmation: ${e.needsConfirm ? 'yes' : 'no'}`, '',
  ].join('\n');
}

function estimateText(e: OverviewEstimate, format: Format): string {
  return format === 'md' ? estimateMarkdown(e) : JSON.stringify(e, null, 2) + '\n';
}

function sendNotice(e: OverviewEstimate): string {
  const what = e.sendSource ? 'structural information and source snippets' : 'structural information (no source code)';
  return `codeinsight: sending ${what} to ${e.provider} (${e.model}): about ${e.llmCalls} request(s), ~${e.inputTokens} input tokens\n`;
}

/** 生成并输出报告；需要确认时估算只写 stderr（--out 留给报告，不被覆盖）；返回退出码 */
async function generate(opts: OverviewOptions, args: OverviewArgs): Promise<number> {
  const start = await startOverview(opts, { confirmed: args.yes, alwaysEstimate: true });
  if (start.kind === 'needs_confirm') {
    process.stderr.write(estimateText(start.estimate, args.format));
    process.stderr.write(`codeinsight: estimated ${start.estimate.inputTokens} input tokens exceeds overview.confirmTokens; rerun with --yes to generate\n`);
    return 2;
  }
  if (start.estimate && start.estimate.llmCalls > 0) process.stderr.write(sendNotice(start.estimate));
  const { id, report } = await start.generate();
  const text = args.format === 'md' ? overviewMarkdown(report) : JSON.stringify(report, null, 2) + '\n';
  const file = await writeTextOutput(text, args.out);
  if (file) log.info('overview_report_written', { id, format: args.format, path: file, bytes: Buffer.byteLength(text) });
  return 0;
}

/** --estimate 只输出估算；否则生成。另一个任务在运行时退出码 1 */
async function estimateOrGenerate(opts: OverviewOptions, args: OverviewArgs): Promise<number> {
  if (args.estimate) {
    await writeTextOutput(estimateText(await estimateOverview(opts), args.format), args.out);
    return 0;
  }
  try {
    return await generate(opts, args);
  } catch (err) {
    if (!(err instanceof OverviewRunningError)) throw err;
    process.stderr.write(`error: an overview is already being generated (pid ${err.pid})\n`);
    return 1;
  }
}

/** codeinsight overview：生成系统概览，输出 JSON 或 Markdown 到 stdout 或 --out */
export async function runOverviewCommand(argv: string[], signal?: AbortSignal): Promise<number> {
  const args = parseOverviewArgs(argv);
  if (args.help) {
    process.stdout.write(OVERVIEW_USAGE);
    return 0;
  }
  const { repo, config, layout, store } = await openWorkspace(args.repo, args['data-dir']);
  try {
    const { snapshot } = await buildSnapshot({ repo, store, layout, config, ref: args.ref });
    const opts: OverviewOptions = {
      repo, store, layout, config, snapshot, ref: args.ref ?? 'working', noLlm: args['no-llm'], noSource: args['no-source'], signal,
    };
    return await estimateOrGenerate(opts, args);
  } finally {
    store.close();
  }
}
