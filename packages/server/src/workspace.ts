import path from 'node:path';
import { checkPyrightExclude, dataDirInRepo, initDataDir, loadConfig, log, repoRoot, Store } from '@codeinsight/core';
import type { CodeInsightConfig, DataDirLayout, Resolver } from '@codeinsight/core';

/** server 运行所需的仓库上下文；由 openServerWorkspace 或测试准备好后传入 */
export interface ServerWorkspace {
  repo: string;
  config: CodeInsightConfig;
  layout: DataDirLayout;
  store: Store;
  /** 测试注入；不传时快照构建用默认的 ScipPythonResolver */
  resolver?: Resolver;
}

export interface OpenWorkspaceOptions {
  /** 命令行的 --data-dir；不传时按配置规则（CODEINSIGHT_DATA_DIR、仓库配置、默认值） */
  dataDir?: string;
  resolver?: Resolver;
}

export interface OpenedWorkspace extends ServerWorkspace {
  /** pyright exclude 的提示，调用方决定是否另外展示（CLI 写 stderr） */
  pyrightHints: string[];
}

/** 关闭工作区的 Store；已关闭等错误只记日志 */
export function closeWorkspaceStore(ws: ServerWorkspace): void {
  try {
    ws.store.close();
  } catch (err) {
    log.warn('repo_store_close_failed', { repo: ws.repo, error: (err as Error).message });
  }
}

/** 打开仓库：定位仓库根目录、读配置、初始化数据目录（含 pyright exclude 检查）、打开库。CLI 命令和切换仓库共用 */
export async function openServerWorkspace(repoArg: string, opts: OpenWorkspaceOptions = {}): Promise<OpenedWorkspace> {
  const repo = await repoRoot(path.resolve(repoArg));
  const config = await loadConfig(repo, { dataDir: opts.dataDir });
  const layout = await initDataDir(config.dataDir);
  const rel = dataDirInRepo(config);
  const pyrightHints = rel ? await checkPyrightExclude(repo, rel) : [];
  for (const hint of pyrightHints) log.info('pyright_exclude_hint', { repo, hint });
  return { repo, config, layout, store: new Store(layout.dbPath), resolver: opts.resolver, pyrightHints };
}
