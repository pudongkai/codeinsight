import path from 'node:path';
import { checkPyrightExclude, dataDirInRepo, initDataDir, loadConfig, repoRoot, Store } from '@codeinsight/core';
import type { CodeInsightConfig, DataDirLayout } from '@codeinsight/core';

export interface Workspace {
  repo: string;
  config: CodeInsightConfig;
  layout: DataDirLayout;
  store: Store;
}

/** 命令共用的准备步骤：定位仓库根目录、读配置、初始化数据目录（含 pyright exclude 提示）、打开库 */
export async function openWorkspace(repoArg: string, dataDir: string | undefined): Promise<Workspace> {
  const repo = await repoRoot(path.resolve(repoArg));
  const config = await loadConfig(repo, { dataDir });
  const layout = await initDataDir(config.dataDir);
  const rel = dataDirInRepo(config);
  if (rel) for (const w of await checkPyrightExclude(repo, rel)) process.stderr.write(`warning: ${w}\n`);
  return { repo, config, layout, store: new Store(layout.dbPath) };
}
