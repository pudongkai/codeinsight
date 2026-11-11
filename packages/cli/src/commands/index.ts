import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildSnapshot, checkPyrightExclude, dataDirInRepo, initDataDir, loadConfig, repoRoot, Store } from '@codeinsight/core';

export const INDEX_USAGE = `Usage: codeinsight index [--repo .] [--ref REF] [--data-dir DIR]

Build the index for the working tree, or for a commit when --ref is given.
`;

/** codeinsight index：构建快照并在 stdout 输出一行 JSON 摘要 */
export async function runIndex(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string', default: '.' },
      ref: { type: 'string' },
      'data-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(INDEX_USAGE);
    return 0;
  }
  const repo = await repoRoot(path.resolve(values.repo));
  const config = await loadConfig(repo, { dataDir: values['data-dir'] });
  const layout = await initDataDir(config.dataDir);
  const rel = dataDirInRepo(config);
  if (rel) for (const w of await checkPyrightExclude(repo, rel)) process.stderr.write(`warning: ${w}\n`);
  const store = new Store(layout.dbPath);
  try {
    const result = await buildSnapshot({ repo, store, layout, config, ref: values.ref });
    const s = result.snapshot;
    const summary = {
      snapshotId: s.id, kind: s.kind, commitSha: s.commitSha, contentKey: s.contentKey, cached: result.cached, resolveRetried: result.resolveRetried,
      resolverStatus: s.resolverStatus, resolverError: s.resolverError, ...store.snapshotStats(s.id),
    };
    process.stdout.write(JSON.stringify(summary) + '\n');
    return 0;
  } finally {
    store.close();
  }
}
