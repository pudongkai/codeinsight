import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { reportToMarkdown, ReviewArgsError, runReview } from '@codeinsight/core';
import type { ReviewOptions } from '@codeinsight/core';
import { openWorkspace } from './workspace.js';

export const REVIEW_USAGE = `Usage: codeinsight review [--repo .] [--base REF] [--head REF | --working]
                          [--intent TEXT | --intent-file PATH] [--no-llm]
                          [--format json|md] [--out PATH] [--data-dir DIR]

Review the structural changes between two versions.
Without --head, reviews uncommitted changes in the working tree against --base (default HEAD).
With --head, --base defaults to <head>~1.
The intent check compares the changes with --intent / --intent-file, or with the commit messages
of the reviewed range. It needs an LLM in codeinsight.config.json or CODEINSIGHT_LLM_PROVIDER;
only a structural summary (no function bodies) is sent.
`;

const FORMATS = ['json', 'md'] as const;
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
      format: { type: 'string', default: 'json' },
      out: { type: 'string' },
      'data-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (!FORMATS.includes(values.format as Format)) throw new ReviewArgsError(`unsupported --format: ${values.format} (expected json or md)`);
  if (values.head !== undefined && values.working) throw new ReviewArgsError('--head and --working cannot be used together');
  if (values.intent !== undefined && values['intent-file'] !== undefined) throw new ReviewArgsError('--intent and --intent-file cannot be used together');
  return { ...values, format: values.format as Format };
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

/** codeinsight review：输出审查报告（JSON 或 Markdown）到 stdout 或 --out 指定的文件 */
export async function runReviewCommand(argv: string[]): Promise<number> {
  const args = parseReviewArgs(argv);
  if (args.help) {
    process.stdout.write(REVIEW_USAGE);
    return 0;
  }
  const intent = await intentArg(args);
  const { repo, config, layout, store } = await openWorkspace(args.repo, args['data-dir']);
  try {
    const report = await runReview({
      repo, store, layout, config, base: args.base, head: args.head, working: args.working, intent, noLlm: args['no-llm'],
      onLlmNotice: (message) => process.stderr.write(`codeinsight: ${message}\n`),
    });
    const text = args.format === 'md' ? reportToMarkdown(report) : JSON.stringify(report, null, 2) + '\n';
    if (args.out) await writeFile(path.resolve(args.out), text);
    else process.stdout.write(text);
    return 0;
  } finally {
    store.close();
  }
}
