import { openServerWorkspace } from '@codeinsight/server';
import type { CodeInsightConfig, DataDirLayout, Store } from '@codeinsight/core';

export interface Workspace {
  repo: string;
  config: CodeInsightConfig;
  layout: DataDirLayout;
  store: Store;
}

/** 命令共用的准备步骤（见 openServerWorkspace），pyright exclude 提示写 stderr */
export async function openWorkspace(repoArg: string, dataDir: string | undefined): Promise<Workspace> {
  const { repo, config, layout, store, pyrightHints } = await openServerWorkspace(repoArg, { dataDir });
  for (const w of pyrightHints) process.stderr.write(`warning: ${w}\n`);
  return { repo, config, layout, store };
}
