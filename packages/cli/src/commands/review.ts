import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { checkPyrightExclude, dataDirInRepo, initDataDir, loadConfig, repoRoot, reportToMarkdown, ReviewArgsError, runReview, Store } from '@codeinsight/core';

export const REVIEW_USAGE = `Usage: codeinsight review [--repo .] [--base REF] [--head REF | --working]
                          [--format json|md] [--out PATH] [--data-dir DIR]

Review the structural changes between two versions.
Without --head, reviews uncommitted changes in the working tree against --base (default HEAD).
With --head, --base defaults to <head>~1.
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
      format: { type: 'string', default: 'json' },
      out: { type: 'string' },
      'data-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (!FORMATS.includes(values.format as Format)) throw new ReviewArgsError(`unsupported --format: ${values.format} (expected json or md)`);
  if (values.head !== undefined && values.working) throw new ReviewArgsError('--head and --working cannot be used together');
  return { ...values, format: values.format as Format };
}

/** codeinsight review：输出审查报告（JSON 或 Markdown）到 stdout 或 --out 指定的文件 */
export async function runReviewCommand(argv: string[]): Promise<number> {
  const args = parseReviewArgs(argv);
  if (args.help) {
    process.stdout.write(REVIEW_USAGE);
    return 0;
  }
  const repo = await repoRoot(path.resolve(args.repo));
  const config = await loadConfig(repo, { dataDir: args['data-dir'] });
  const layout = await initDataDir(config.dataDir);
  const rel = dataDirInRepo(config);
  if (rel) for (const w of await checkPyrightExclude(repo, rel)) process.stderr.write(`warning: ${w}\n`);
  const store = new Store(layout.dbPath);
  try {
    const report = await runReview({ repo, store, layout, config, base: args.base, head: args.head, working: args.working });
    const text = args.format === 'md' ? reportToMarkdown(report) : JSON.stringify(report, null, 2) + '\n';
    if (args.out) await writeFile(path.resolve(args.out), text);
    else process.stdout.write(text);
    return 0;
  } finally {
    store.close();
  }
}
