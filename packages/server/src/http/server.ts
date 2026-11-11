import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { log } from '@codeinsight/core';
import { IndexJobs } from '../jobs/index-jobs.js';
import { ReviewJobs } from '../jobs/review-jobs.js';
import type { ServerWorkspace } from '../workspace.js';
import { authenticate, hostAllowed, newToken, sessionCookie, tokenMatches } from './auth.js';
import type { AppContext, RequestContext, Route } from './context.js';
import { HttpError, sendError, sendJson } from './respond.js';
import { matchRoute } from './router.js';
import { entryRoutes } from './routes/entries.js';
import { indexRoutes } from './routes/index-jobs.js';
import { reviewRoutes } from './routes/reviews.js';
import { similarRoutes } from './routes/similar.js';
import { sourceRoutes } from './routes/source.js';
import { serveStatic } from './routes/static.js';
import { statusRoutes } from './routes/status.js';
import { symbolRoutes } from './routes/symbols.js';

const ROUTES: Route[] = [...statusRoutes, ...reviewRoutes, ...indexRoutes, ...sourceRoutes, ...symbolRoutes, ...entryRoutes, ...similarRoutes];

/** 只监听本机回环地址 */
export const LISTEN_HOST = '127.0.0.1';

export interface HttpServerOptions {
  workspace: ServerWorkspace;
  /** 0 为随机端口 */
  port?: number;
  /** Web UI 构建产物目录 */
  staticDir?: string;
  /** 启动时对当前工作区建索引（已有可复用快照时直接复用），默认 true */
  indexOnStart?: boolean;
  /** 定时更新当前快照 last_used_at 的间隔，默认 5 分钟（小于清理规则的 10 分钟） */
  keepAliveMs?: number;
}

const DEFAULT_KEEP_ALIVE_MS = 5 * 60 * 1000;

export interface RunningHttpServer {
  port: number;
  token: string;
  /** 带 `?token=` 的首页地址 */
  url: string;
  indexJobs: IndexJobs;
  reviewJobs: ReviewJobs;
  /** 停止监听；drain 为 true 时还等正在跑的审查和建索引任务结束 */
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

async function dispatch(ctx: RequestContext): Promise<void> {
  const { pathname } = ctx.url;
  if (pathname !== '/api' && !pathname.startsWith('/api/')) return serveStatic(ctx);
  const match = matchRoute(ROUTES, ctx.req.method ?? 'GET', pathname);
  if (!match) throw new HttpError(404, 'not_found');
  ctx.params = match.params;
  await match.route.handler(ctx);
}

function handleError(ctx: RequestContext, err: unknown): void {
  if (ctx.res.headersSent) {
    ctx.res.destroy();
    return;
  }
  if (err instanceof HttpError) return sendError(ctx.res, err);
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

/**
 * 启动本地 HTTP 服务：只监听 127.0.0.1，token 由加密安全随机数生成。
 * 启动时把遗留的 running 审查改为 failed，并在后台对当前工作区建索引。
 */
export async function startHttpServer(opts: HttpServerOptions): Promise<RunningHttpServer> {
  const ws = opts.workspace;
  const token = newToken();
  const app: AppContext = { ws, indexJobs: new IndexJobs(ws), reviewJobs: new ReviewJobs(ws), staticDir: opts.staticDir, touched: new Map() };
  let port = 0;
  const server = createServer((req, res) => void handle(app, token, port, req, res));
  port = await listen(server, opts.port ?? 0);
  log.info('http_listening', { host: LISTEN_HOST, port, repo: ws.repo, staticDir: opts.staticDir });
  if (opts.indexOnStart !== false) app.indexJobs.start('startup');
  const keepAlive = setInterval(() => app.indexJobs.touchCurrent(), opts.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS);
  keepAlive.unref();
  return {
    port, token, url: `http://${LISTEN_HOST}:${port}/?token=${token}`, indexJobs: app.indexJobs, reviewJobs: app.reviewJobs,
    close: async ({ drain = true } = {}) => {
      clearInterval(keepAlive);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (drain) await Promise.all([app.reviewJobs.drain(), app.indexJobs.drain()]);
      log.info('http_closed', { port });
    },
  };
}
