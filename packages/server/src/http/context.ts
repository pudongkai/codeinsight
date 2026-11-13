import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DirPicker } from '../dir-picker.js';
import type { RepoContext } from '../repo-context.js';
import type { ServerWorkspace } from '../workspace.js';
import { HttpError } from './respond.js';

/** 一个 serve 进程内各路由共用的状态；仓库相关的对象都在 repo 里，切换仓库就是换一个 RepoContext */
export interface AppContext {
  /** 当前仓库；无仓库启动且还没打开仓库时为 undefined */
  repo: RepoContext | undefined;
  /** 启动时打开的仓库（真实路径）和它使用的数据目录；切回这个仓库时沿用同一个数据目录 */
  startup: { repo?: string; dataDir?: string };
  /** 下一个仓库上下文的 gen */
  nextGen: number;
  /** 正在切换仓库 */
  switching: boolean;
  /** 正在关闭服务：进行中的切换不再替换上下文 */
  shuttingDown: boolean;
  /** 带 --lock-repo 启动：不能切换到别的仓库 */
  locked: boolean;
  /** 打开仓库后是否在后台建索引 */
  indexOnOpen: boolean;
  /** 本进程已做过中断记录恢复的数据目录 */
  recoveredDataDirs: Set<string>;
  /** 切换后正在关闭的旧上下文，关闭服务时等它们结束 */
  closingRepos: Set<Promise<void>>;
  /** 静态文件目录（Web UI 构建产物）；不存在时首页显示占位页 */
  staticDir?: string;
  /** 打开仓库；默认 openServerWorkspace，测试可注入 */
  openWorkspace: (repo: string, dataDir?: string) => Promise<ServerWorkspace>;
  /** 读 LLM 配置用的环境变量；默认 process.env，测试传空对象避免读到本机的 key */
  env: NodeJS.ProcessEnv;
  /** 系统选择文件夹窗口 */
  dirPicker: DirPicker;
  /** 代码变化检测的最小间隔 */
  changeCheckIntervalMs: number;
  /** 测试连接：超时和是否有测试在进行 */
  llmTest: { timeoutMs: number; running: boolean };
}

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  app: AppContext;
  /** 进入路由时取的当前仓库，整个请求只用它 */
  repo?: RepoContext;
  /** 请求日志里附带的关键参数，路由可以追加 */
  logFields: Record<string, unknown>;
}

export type Handler = (ctx: RequestContext) => Promise<void> | void;

export interface Route {
  method: 'GET' | 'POST' | 'DELETE';
  /** 如 `/api/symbols/:snapshot/:id/callers` */
  pattern: string;
  handler: Handler;
  /** 默认 true：没有当前仓库时返回 409 `no_repo`，并检查 X-CodeInsight-Repo；为 false 时两者都不做 */
  needsRepo?: boolean;
}

/** 当前请求的仓库上下文；没有仓库时 409 `no_repo` */
export function repoOf(ctx: RequestContext): RepoContext {
  if (!ctx.repo) throw new HttpError(409, 'no_repo', 'no repository is open');
  return ctx.repo;
}
