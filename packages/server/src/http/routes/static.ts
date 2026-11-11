import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { log } from '@codeinsight/core';
import type { RequestContext } from '../context.js';
import { resolveInside } from '../paths.js';
import { HttpError } from '../respond.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Web UI 还没构建时的首页 */
const PLACEHOLDER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>CodeInsight</title></head>
<body><h1>CodeInsight</h1><p>The server is running, but the web UI has not been built yet. The HTTP API is available under <code>/api/</code>.</p></body></html>
`;

function send(ctx: RequestContext, status: number, type: string, body: Buffer | string): void {
  const data = typeof body === 'string' ? Buffer.from(body) : body;
  ctx.res.writeHead(status, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
  ctx.res.end(ctx.req.method === 'HEAD' ? undefined : data);
}

async function existingFile(dir: string, rel: string): Promise<string | undefined> {
  const file = await resolveInside(dir, rel);
  return file && (await stat(file)).isFile() ? file : undefined;
}

/**
 * 托管静态文件目录；没有扩展名的路径（前端路由）回落到 index.html。
 * 目录不存在或没有 index.html 时首页返回占位页。
 */
export async function serveStatic(ctx: RequestContext): Promise<void> {
  if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');
  let rel: string;
  try {
    rel = decodeURIComponent(ctx.url.pathname).replace(/^\/+/, '') || 'index.html';
  } catch {
    throw new HttpError(400, 'invalid_path');
  }
  const dir = ctx.app.staticDir;
  const spa = path.posix.extname(rel) === '';
  let file: string | undefined;
  try {
    file = dir ? ((await existingFile(dir, rel)) ?? (spa ? await existingFile(dir, 'index.html') : undefined)) : undefined;
  } catch (err) {
    if (err instanceof HttpError && err.status === 403) log.warn('static_path_rejected', { path: rel });
    throw err;
  }
  if (file) return send(ctx, 200, CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', await readFile(file));
  if (rel === 'index.html' || spa) return send(ctx, 200, CONTENT_TYPES['.html']!, PLACEHOLDER);
  throw new HttpError(404, 'not_found');
}
