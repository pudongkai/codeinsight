import { cpSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildSnapshot, initDataDir, loadConfig, Store } from '../../src/index.js';
import type { AskToolContext, CodeInsightConfig, DataDirLayout, SnapshotRow } from '../../src/index.js';
import { commitAll, git, tempDir } from './git-repo.js';

const FIXTURE = path.join(import.meta.dirname, '..', 'fixtures', 'py-shop');

export interface AskEnv {
  repo: string;
  config: CodeInsightConfig;
  layout: DataDirLayout;
  store: Store;
  snapshot: SnapshotRow;
}

/** py-shop 加一个 300 行的文件（setup 可以再改仓库），建好工作区快照 */
export async function askEnv(setup?: (repo: string) => void): Promise<AskEnv> {
  const repo = tempDir('ci-ask-');
  cpSync(FIXTURE, repo, { recursive: true });
  const long = Array.from({ length: 300 }, (_, i) => `VALUE_${i + 1} = ${i + 1}`).join('\n') + '\n';
  writeFileSync(path.join(repo, 'app', 'long_values.py'), long);
  writeFileSync(path.join(repo, 'codeinsight.config.json'), JSON.stringify({ overview: { moduleMinSize: 3, moduleMaxSize: 15, leafSplitSize: 8 } }));
  setup?.(repo);
  git(repo, 'init', '-q', '-b', 'main');
  commitAll(repo, 'init');
  const config = await loadConfig(repo, { dataDir: tempDir('ci-ask-data-'), env: {} });
  const layout = await initDataDir(config.dataDir);
  const store = new Store(layout.dbPath);
  const { snapshot } = await buildSnapshot({ repo, store, layout, config });
  return { repo, config, layout, store, snapshot };
}

export function toolContext(env: AskEnv, extra: Partial<AskToolContext> = {}): AskToolContext {
  return { repo: env.repo, store: env.store, layout: env.layout, snapshot: env.snapshot, sendSource: true, ...extra };
}

/** 工具结果里某个符号的 id（行格式 `<id> <kind> <qualifiedName> @ <path>:...`） */
export function idOf(text: string, qualifiedName: string, file?: string): string | undefined {
  for (const line of text.split('\n')) {
    const m = /^\s*(\S+) \S+ (\S+) @ ([^:]+):/.exec(line);
    if (m && m[2] === qualifiedName && (!file || m[3] === file)) return m[1];
  }
  return undefined;
}
