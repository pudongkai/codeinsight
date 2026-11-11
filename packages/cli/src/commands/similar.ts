import { parseArgs } from 'node:util';
import { buildSnapshot, duplicatesToMarkdown, FUNCTION_KINDS, ReviewArgsError, similarInSnapshot, symbolIdFromKey } from '@codeinsight/core';
import type { DuplicateFinding } from '@codeinsight/core';
import { openWorkspace } from './workspace.js';

export const SIMILAR_USAGE = `Usage: codeinsight similar [--repo .] [--symbol KEY | --all] [--ref REF] [--min-score 0.6]
                           [--format json|md] [--data-dir DIR]

Find duplicate implementations in the working tree, or in a commit when --ref is given.
--symbol KEY  candidates for one function (KEY is a symbol_key, e.g. pkg/a.py#function#load#)
--all         scan all non-test functions; each pair is reported once
`;

const FORMATS = ['json', 'md'] as const;
type Format = (typeof FORMATS)[number];

function parseSimilarArgs(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string', default: '.' },
      symbol: { type: 'string' },
      all: { type: 'boolean' },
      ref: { type: 'string' },
      'min-score': { type: 'string' },
      format: { type: 'string', default: 'json' },
      'data-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) return { ...values, format: 'json' as Format, minScore: undefined };
  if ((values.symbol === undefined) === !values.all) throw new ReviewArgsError('specify exactly one of --symbol KEY or --all');
  if (!FORMATS.includes(values.format as Format)) throw new ReviewArgsError(`unsupported --format: ${values.format} (expected json or md)`);
  const minScore = values['min-score'] === undefined ? undefined : Number(values['min-score']);
  if (minScore !== undefined && !(minScore >= 0 && minScore <= 1)) throw new ReviewArgsError(`--min-score must be a number between 0 and 1: ${values['min-score']}`);
  return { ...values, format: values.format as Format, minScore };
}

interface SimilarOutput {
  repo: string;
  snapshotId: number;
  commitSha: string;
  working: boolean;
  minScore: number;
  findings: DuplicateFinding[];
}

function toMarkdown(out: SimilarOutput): string {
  const version = out.working ? `working tree (HEAD ${out.commitSha.slice(0, 12)})` : out.commitSha.slice(0, 12);
  const body = duplicatesToMarkdown(out.findings, '## Duplicates');
  return ['# CodeInsight similar', '', `- Repo: \`${out.repo}\``, `- Version: ${version}`, `- Min score: ${out.minScore}`, '', ...(body.length ? body : ['No duplicates found.', ''])].join('\n');
}

/** codeinsight similar：在工作区或指定提交的快照上找重复实现，输出 JSON 或 Markdown 到 stdout */
export async function runSimilarCommand(argv: string[]): Promise<number> {
  const args = parseSimilarArgs(argv);
  if (args.help) {
    process.stdout.write(SIMILAR_USAGE);
    return 0;
  }
  const { repo, config, layout, store } = await openWorkspace(args.repo, args['data-dir']);
  try {
    const { snapshot } = await buildSnapshot({ repo, store, layout, config, ref: args.ref });
    const minScore = args.minScore ?? config.similarMinScore;
    let queryIds: string[] | undefined;
    if (args.symbol !== undefined) {
      const sym = store.getSymbol(snapshot.id, symbolIdFromKey(args.symbol));
      if (!sym) throw new ReviewArgsError(`symbol not found: ${args.symbol}`);
      if (!FUNCTION_KINDS.has(sym.kind)) throw new ReviewArgsError(`not a function or method: ${args.symbol}`);
      queryIds = [sym.id];
    }
    const { findings } = similarInSnapshot(store, snapshot.id, { queryIds, minScore });
    const out: SimilarOutput = { repo, snapshotId: snapshot.id, commitSha: snapshot.commitSha, working: snapshot.kind === 'working', minScore, findings };
    process.stdout.write(args.format === 'md' ? toMarkdown(out) : JSON.stringify(out, null, 2) + '\n');
    return 0;
  } finally {
    store.close();
  }
}
