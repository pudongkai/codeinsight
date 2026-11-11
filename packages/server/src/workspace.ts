import type { CodeInsightConfig, DataDirLayout, Resolver, Store } from '@codeinsight/core';

/** server 运行所需的仓库上下文；由 CLI 的 openWorkspace 或测试准备好后传入 */
export interface ServerWorkspace {
  repo: string;
  config: CodeInsightConfig;
  layout: DataDirLayout;
  store: Store;
  /** 测试注入；不传时快照构建用默认的 ScipPythonResolver */
  resolver?: Resolver;
}
