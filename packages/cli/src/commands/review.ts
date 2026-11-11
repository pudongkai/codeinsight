import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { log, reportToMarkdown, ReviewArgsError, runReview } from '@codeinsight/core';
import type { ReviewOptions, ReviewReport } from '@codeinsight/core';
import { openBrowser } from '../open-browser.js';
import { DEFAULT_REPORT_TEMPLATE } from '../web-assets.js';
import { readReportTemplate, renderHtmlReport } from './html-report.js';
import { openWorkspace } from './workspace.js';

export const REVIEW_USAGE = `Usage: codeinsight review [--repo .] [--base REF] [--head REF | --working]
                          [--intent TEXT | --intent-file PATH] [--no-llm]
                          [--format json|md|html] [--out PATH] [--open] [--data-dir DIR]

Review the structural changes between two versions.
Without --head, reviews uncommitted changes in the working tree against --base (default HEAD).
With --head, --base defaults to <head>~1.
The intent check compares the changes with --intent / --intent-file, or with the commit messages
of the reviewed range. It needs an LLM in codeinsight.config.json or CODEINSIGHT_LLM_PROVIDER;
only a structural summary (no function bodies) is sent.
--format html writes a single self-contained HTML file (no network access needed to view it).
--open implies --format html and opens the file in the default browser (written to a temp file without --out).
`;

const FORMATS = ['json', 'md', 'html'] as const;
type Format = (typeof FORMATS)[number];

function parseReviewArgs(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string', default: '.' },
      base: { type: 'string' },
      head: { type: 'string' },
      working: { type: 'boolean' },
      intent: { type: 'string' },
      'intent-file': { type: 'string' },
      'no-llm': { type: 'boolean' },
      format: { type: 'string' },
      out: { type: 'string' },
      open: { type: 'boolean' },
      'data-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  const format = values.format ?? (values.open ? 'html' : 'json');
  if (!FORMATS.includes(format as Format)) throw new ReviewArgsError(`unsupported --format: ${format} (expected json, md or html)`);
  if (values.open && format !== 'html') throw new ReviewArgsError('--open only works with --format html');
  if (values.head !== undefined && values.working) throw new ReviewArgsError('--head and --working cannot be used together');
  if (values.intent !== undefined && values['intent-file'] !== undefined) throw new ReviewArgsError('--intent and --intent-file cannot be used together');
  return { ...values, format: format as Format };
}

async function intentArg(args: ReturnType<typeof parseReviewArgs>): Promise<ReviewOptions['intent']> {
  if (args.intent !== undefined) return { source: 'arg', text: args.intent };
  const file = args['intent-file'];
  if (file === undefined) return undefined;
  try {
    return { source: 'file', text: await readFile(path.resolve(file), 'utf8') };
  } catch (err) {
    throw new ReviewArgsError(`cannot read --intent-file ${file}: ${(err as Error).message}`);
  }
}

export interface ReviewDeps {
  /** 测试注入，替代系统浏览器 */
  openUrl?: (url: string) => void;
  /** HTML 报告模板，默认为 cli 发布目录里的 web/report.html */
  templatePath?: string;
}

type ReviewArgs = ReturnType<typeof parseReviewArgs>;

function renderReport(report: ReviewReport, format: Format, template: string | undefined): string {
  if (format === 'html') return renderHtmlReport(report, template!);
  return format === 'md' ? reportToMarkdown(report) : JSON.stringify(report, null, 2) + '\n';
}

/** 写到 --out、--open 时的临时文件或 stdout；--open 时用浏览器打开写出的文件 */
async function writeOutput(text: string, args: ReviewArgs, deps: ReviewDeps): Promise<void> {
  const out = args.out ?? (args.open ? path.join(tmpdir(), `codeinsight-review-${Date.now()}.html`) : undefined);
  if (out === undefined) {
    process.stdout.write(text);
    return;
  }
  const file = path.resolve(out);
  await writeFile(file, text);
  log.info('review_report_written', { format: args.format, path: file, bytes: Buffer.byteLength(text) });
  if (!args.open) return;
  const url = pathToFileURL(file).href;
  (deps.openUrl ?? openBrowser)(url);
  log.info('review_report_opened', { url });
}

/** codeinsight review：输出审查报告（JSON、Markdown 或单文件 HTML）到 stdout 或 --out 指定的文件 */
export async function runReviewCommand(argv: string[], deps: ReviewDeps = {}): Promise<number> {
  const args = parseReviewArgs(argv);
  if (args.help) {
    process.stdout.write(REVIEW_USAGE);
    return 0;
  }
  const intent = await intentArg(args);
  // 先读模板：web 没构建时在跑审查之前就报错
  const template = args.format === 'html' ? await readReportTemplate(deps.templatePath ?? DEFAULT_REPORT_TEMPLATE) : undefined;
  const { repo, config, layout, store } = await openWorkspace(args.repo, args['data-dir']);
  try {
    const report = await runReview({
      repo, store, layout, config, base: args.base, head: args.head, working: args.working, intent, noLlm: args['no-llm'],
      onLlmNotice: (message) => process.stderr.write(`codeinsight: ${message}\n`),
    });
    await writeOutput(renderReport(report, args.format, template), args, deps);
    return 0;
  } finally {
    store.close();
  }
}
