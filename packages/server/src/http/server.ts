import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { log, realPathOr } from '@codeinsight/core';
import type { AskToolServer, Resolver } from '@codeinsight/core';
import { CHANGE_CHECK_INTERVAL_MS } from '../changes.js';
import { detectPickerTool, execPicker, PICKER_TIMEOUT_MS, type PickerTool, type RunPicker } from '../dir-picker.js';
import { closeRepoContext, createRepoContext, rememberRepo, type RepoContext } from '../repo-context.js';
import { RepoClosedError } from '../jobs/closed.js';
import { closeWorkspaceStore, openServerWorkspace, type ServerWorkspace } from '../workspace.js';
import { authenticate, hostAllowed, newToken, sessionCookie, tokenMatches } from './auth.js';
import type { AppContext, RequestContext, Route } from './context.js';
import { HttpError, sendError, sendJson } from './respond.js';
import { matchRoute } from './router.js';
import { chatRoutes } from './routes/chat.js';
import { entryRoutes } from './routes/entries.js';
import { indexRoutes } from './routes/index-jobs.js';
import { overviewRoutes } from './routes/overview.js';
import { repoRoutes } from './routes/repos.js';
import { reviewRoutes } from './routes/reviews.js';
import { similarRoutes } from './routes/similar.js';
import { sourceRoutes } from './routes/source.js';
import { settingsRoutes } from './routes/settings.js';
import { serveStatic } from './routes/static.js';
import { statusRoutes } from './routes/status.js';
import { symbolRoutes } from './routes/symbols.js';

const ROUTES: Route[] = [...statusRoutes, ...repoRoutes, ...settingsRoutes, ...reviewRoutes, ...indexRoutes, ...sourceRoutes, ...symbolRoutes, ...entryRoutes, ...similarRoutes, ...overviewRoutes, ...chatRoutes];

/** 只监听本机回环地址 */
export const LISTEN_HOST = '127.0.0.1';

export interface HttpServerOptions {
  /** 启动时打开的仓库；不传时以无仓库启动，等网页选择仓库 */
  workspace?: ServerWorkspace;
  /** 锁定启动时的仓库，不能切换到别的仓库；必须同时传 workspace */
  lockRepo?: boolean;
  /** 切换仓库时打开工作区；默认 openServerWorkspace */
  openWorkspace?: (repo: string, dataDir?: string) => Promise<ServerWorkspace>;
  /** 默认 openWorkspace 打开的工作区使用的解析器（测试注入）；不传时沿用 workspace 的 */
  resolver?: Resolver;
  /** 0 为随机端口 */
  port?: number;
  /** Web UI 构建产物目录 */
  staticDir?: string;
  /** 打开仓库时（启动和切换）对工作区建索引（已有可复用快照时直接复用），默认 true */
  indexOnStart?: boolean;
  /** 定时更新当前快照 last_used_at 的间隔，默认 5 分钟（小于清理规则的 10 分钟） */
  keepAliveMs?: number;
  /** 读 LLM 配置用的环境变量，默认 process.env */
  env?: NodeJS.ProcessEnv;
  /** 选择文件夹窗口：测试注入可用的命令（null 为不可用）、执行函数和超时，不真弹窗 */
  dirPicker?: { tool?: PickerTool | null; runPicker?: RunPicker; timeoutMs?: number };
  /** 代码变化检测的最小间隔，默认 10 秒 */
  changeCheckIntervalMs?: number;
  /** 测试连接的超时，默认 20 秒 */
  llmTestTimeoutMs?: number;
  /** 本机 CLI 测试连接的超时，默认 90 秒 */
  llmTestCliTimeoutMs?: number;
  /** 本机 CLI 问答用的工具服务启动命令（`codeinsight mcp --ask-tools`） */
  askToolServer?: AskToolServer;
}

const LLM_TEST_TIMEOUT_MS = 20_000;
const LLM_TEST_CLI_TIMEOUT_MS = 90_000;

const DEFAULT_KEEP_ALIVE_MS = 5 * 60 * 1000;

export interface RunningHttpServer {
  port: number;
  token: string;
  /** 带 `?token=` 的首页地址 */
  url: string;
  /** 当前仓库上下文，没有仓库时为 undefined（测试用） */
  app(): RepoContext | undefined;
  /**
   * 停止监听并关闭当前仓库的 Store；drain 为 true 时先等正在跑的审查、建索引、概览任务结束，
   * 并中止进行中的问答、等它们保存回答
   */
  close(opts?: { drain?: boolean }): Promise<void>;
}

/** 请求日志里的查询参数：去掉 token，过长的值截断 */
function queryFields(url: URL): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of url.searchParams) if (k !== 'token') out[k] = v.length > 200 ? v.slice(0, 200) + '…' : v;
  return out;
}

function logRequest(ctx: RequestContext, started: number): void {
  const status = ctx.res.statusCode;
  const fields = { method: ctx.req.method, path: ctx.url.pathname, status, ms: Date.now() - started, ...ctx.logFields };
  if (status >= 500) log.error('http_request', fields);
  else log.info('http_request', fields);
}

/**
 * 请求进入路由前的检查：Host / Origin、首页 `?token=` 换 cookie 并重定向到不带 token 的地址、cookie 或 Bearer 认证。
 * 已经写好响应（重定向）时返回 false。
 */
function gate(ctx: RequestContext, token: string, port: number): boolean {
  const { req, res, url } = ctx;
  if (!hostAllowed(req, port)) {
    log.warn('http_host_rejected', { host: req.headers.host, origin: req.headers.origin, path: url.pathname });
    throw new HttpError(403, 'forbidden_host');
  }
  const given = url.searchParams.get('token');
  if (url.pathname === '/' && given !== null) {
    if (!tokenMatches(token, given)) {
      log.warn('http_auth_failed', { method: req.method, path: url.pathname, reason: 'invalid_url_token' });
      throw new HttpError(401, 'unauthorized');
    }
    res.writeHead(302, { 'Set-Cookie': sessionCookie(port, token), Location: '/', 'Cache-Control': 'no-store' });
    res.end();
    log.info('http_token_login', { path: url.pathname });
    return false;
  }
  const auth = authenticate(req, token, port);
  if (!auth.ok) {
    log.warn('http_auth_failed', { method: req.method, path: url.pathname, reason: auth.reason });
    throw new HttpError(401, 'unauthorized');
  }
  return true;
}

export const REPO_HEADER = 'x-codeinsight-repo';

/** 请求带的仓库标识（gen）和当前仓库不同时 409 `repo_changed`；不带的照常处理 */
function checkRepoHeader(ctx: RequestContext): void {
  const raw = ctx.req.headers[REPO_HEADER];
  if (raw === undefined) return;
  const current = ctx.app.repo?.gen ?? null;
  if (String(raw) === String(current)) return;
  ctx.logFields.repoHeader = raw;
  throw new HttpError(409, 'repo_changed', 'the repository has changed', { repoGen: current });
}

/**
 * 进入路由时取一次当前仓库，整个请求只用它。需要仓库的路由请求期间计入它的 inflight，关闭旧 Store 前等请求结束；
 * 不需要仓库的路由（选择目录、测试连接等可能很久）不计入，切换仓库不用等它们。
 */
async function runRoute(ctx: RequestContext, route: Route): Promise<void> {
  const needsRepo = route.needsRepo !== false;
  if (needsRepo) {
    checkRepoHeader(ctx);
    if (!ctx.app.repo) throw new HttpError(409, 'no_repo', 'no repository is open');
  }
  ctx.repo = ctx.app.repo;
  const repo = needsRepo ? ctx.repo : undefined;
  if (repo) repo.inflight++;
  try {
    await route.handler(ctx);
  } finally {
    if (repo) repo.inflight--;
  }
}

async function dispatch(ctx: RequestContext): Promise<void> {
  const { pathname } = ctx.url;
  if (pathname !== '/api' && !pathname.startsWith('/api/')) return serveStatic(ctx);
  const match = matchRoute(ROUTES, ctx.req.method ?? 'GET', pathname);
  if (!match) throw new HttpError(404, 'not_found');
  ctx.params = match.params;
  await runRoute(ctx, match.route);
}

function handleError(ctx: RequestContext, err: unknown): void {
  if (ctx.res.headersSent) {
    ctx.res.destroy();
    return;
  }
  if (err instanceof HttpError) return sendError(ctx.res, err);
  if (err instanceof RepoClosedError) {
    ctx.logFields.repoClosed = err.task;
    return sendError(ctx.res, new HttpError(409, 'repo_changed', 'the repository has changed', { repoGen: ctx.app.repo?.gen ?? null }));
  }
  // 详情只写日志：错误信息里可能有本机绝对路径
  ctx.logFields.error = (err as Error).message;
  sendJson(ctx.res, 500, { error: 'internal_error' });
}

async function handle(app: AppContext, token: string, port: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = Date.now();
  const url = new URL(req.url ?? '/', `http://${LISTEN_HOST}:${port}`);
  const ctx: RequestContext = { req, res, url, params: {}, app, logFields: queryFields(url) };
  res.on('finish', () => logRequest(ctx, started));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    if (gate(ctx, token, port)) await dispatch(ctx);
  } catch (err) {
    handleError(ctx, err);
  }
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LISTEN_HOST, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/** 选择文件夹窗口：锁定仓库时不可用；没有注入时检测本机命令 */
async function pickerTool(opts: HttpServerOptions): Promise<PickerTool | undefined> {
  if (opts.lockRepo) return undefined;
  const injected = opts.dirPicker?.tool;
  if (injected !== undefined) return injected ?? undefined;
  return detectPickerTool();
}

async function newAppContext(opts: HttpServerOptions): Promise<AppContext> {
  const ws = opts.workspace;
  if (opts.lockRepo && !ws) throw new Error('lockRepo requires a workspace');
  const resolver = opts.resolver ?? ws?.resolver;
  const dp = opts.dirPicker;
  return {
    repo: undefined,
    startup: ws ? { repo: await realPathOr(ws.repo), dataDir: path.resolve(ws.config.dataDir) } : {},
    nextGen: 1, switching: false, shuttingDown: false, locked: opts.lockRepo === true, indexOnOpen: opts.indexOnStart !== false,
    recoveredDataDirs: new Set(), closingRepos: new Set(), staticDir: opts.staticDir,
    openWorkspace: opts.openWorkspace ?? ((repo, dataDir) => openServerWorkspace(repo, { dataDir, resolver })),
    env: opts.env ?? process.env,
    dirPicker: { tool: await pickerTool(opts), runPicker: dp?.runPicker ?? execPicker, timeoutMs: dp?.timeoutMs ?? PICKER_TIMEOUT_MS, busy: false },
    changeCheckIntervalMs: opts.changeCheckIntervalMs ?? CHANGE_CHECK_INTERVAL_MS,
    llmTest: { timeoutMs: opts.llmTestTimeoutMs ?? LLM_TEST_TIMEOUT_MS, cliTimeoutMs: opts.llmTestCliTimeoutMs ?? LLM_TEST_CLI_TIMEOUT_MS, running: false },
    ...(opts.askToolServer ? { askToolServer: opts.askToolServer } : {}),
  };
}

/** 关闭服务时：关闭当前上下文（drain 时先等任务结束）和切换后还在关闭的旧上下文 */
async function closeRepos(app: AppContext, drain: boolean): Promise<void> {
  const cur = app.repo;
  app.repo = undefined;
  await Promise.all([
    cur ? closeRepoContext(cur, { drain, reason: 'server_closing' }) : undefined,
    ...app.closingRepos,
  ]);
}

/**
 * 启动本地 HTTP 服务：只监听 127.0.0.1，token 由加密安全随机数生成。
 * 传了 workspace 时作为当前仓库：把遗留的 running 任务改为 failed，并在后台对工作区建索引；不传时以无仓库启动。
 */
export async function startHttpServer(opts: HttpServerOptions): Promise<RunningHttpServer> {
  const app = await newAppContext(opts);
  const token = newToken();
  let port = 0;
  const server = createServer((req, res) => void handle(app, token, port, req, res));
  try {
    port = await listen(server, opts.port ?? 0);
  } catch (err) {
    // 端口被占用等：还没开始建索引，交给本服务的 Store 在这里关掉
    if (opts.workspace) closeWorkspaceStore(opts.workspace);
    throw err;
  }
  // 监听成功后才建仓库上下文（会开始建索引）；token 此时还没交出去，不会有请求先到
  if (opts.workspace) app.repo = createRepoContext(app, opts.workspace, 'startup');
  log.info('http_listening', { host: LISTEN_HOST, port, repo: app.repo?.ws.repo ?? null, locked: app.locked, dirPicker: app.dirPicker.tool ?? null, staticDir: opts.staticDir });
  if (app.repo) await rememberRepo(app.repo.ws.repo);
  const keepAlive = setInterval(() => app.repo?.indexJobs.touchCurrent(), opts.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS);
  keepAlive.unref();
  return {
    port, token, url: `http://${LISTEN_HOST}:${port}/?token=${token}`, app: () => app.repo,
    close: async ({ drain = true } = {}) => {
      clearInterval(keepAlive);
      app.shuttingDown = true;
      app.llmTest.controller?.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closeRepos(app, drain);
      log.info('http_closed', { port });
    },
  };
}
