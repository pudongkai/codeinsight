import { stat } from 'node:fs/promises';
import path from 'node:path';
import { readUserSettings, removeRecentRepo } from '@codeinsight/core';
import { pickDirectory, PickerBusyError, PickerFailedError, PickerUnavailableError } from '../../dir-picker.js';
import { openRepo, parseOpenRepoBody } from '../../repo-switch.js';
import type { Route, RequestContext } from '../context.js';
import { HttpError, readJsonBody, sendJson } from '../respond.js';

async function isDirectory(p: string): Promise<boolean> {
  return (await stat(p).catch(() => undefined))?.isDirectory() ?? false;
}

/** GET /api/repos：当前仓库、启动时的仓库、最近打开的仓库（带路径现在是否还是目录） */
async function listRepos(ctx: RequestContext): Promise<void> {
  const { app } = ctx;
  const cur = ctx.repo;
  const settings = await readUserSettings();
  const recent = await Promise.all(settings.recentRepos.map(async (r) => ({ ...r, exists: await isDirectory(r.path) })));
  sendJson(ctx.res, 200, {
    current: cur ? { path: cur.ws.repo, gen: cur.gen, dataDir: path.resolve(cur.ws.config.dataDir) } : null,
    startupRepo: app.startup.repo ?? null,
    locked: app.locked,
    recent,
  });
}

/** POST /api/repo `{path, cancelRunning?}`：打开或切换仓库 */
async function postRepo(ctx: RequestContext): Promise<void> {
  const req = parseOpenRepoBody(await readJsonBody(ctx.req));
  Object.assign(ctx.logFields, { path: req.path, cancelRunning: req.cancelRunning });
  const r = await openRepo(ctx.app, req);
  Object.assign(ctx.logFields, { repoGen: r.repoGen, reused: r.reused });
  sendJson(ctx.res, 200, { ...r, dataDir: path.resolve(r.dataDir) });
}

/** DELETE /api/repos/recent?path=：从最近列表移除，不存在也返回 204 */
async function deleteRecent(ctx: RequestContext): Promise<void> {
  const p = ctx.url.searchParams.get('path') ?? '';
  if (p === '') throw new HttpError(400, 'invalid_param', 'path is required');
  await removeRecentRepo(p);
  ctx.res.writeHead(204, { 'Cache-Control': 'no-store' });
  ctx.res.end();
}

/** 弹窗相关错误转成 HTTP 错误；失败详情只在日志里 */
function pickerHttpError(err: unknown): unknown {
  if (err instanceof PickerBusyError) return new HttpError(409, 'picker_busy', err.message);
  if (err instanceof PickerUnavailableError) return new HttpError(409, 'picker_unavailable', err.message);
  if (err instanceof PickerFailedError) return new HttpError(500, 'picker_failed', err.message);
  return err;
}

/**
 * POST /api/repo/pick-dir：在本机弹出系统选择文件夹窗口，只返回选中的路径，不打开仓库。
 * 客户端断开时结束弹窗进程。
 */
async function pickDir(ctx: RequestContext): Promise<void> {
  if (ctx.app.locked) throw new HttpError(409, 'repo_locked', 'the repository is locked for this server');
  const controller = new AbortController();
  const onClose = () => {
    if (!ctx.res.writableFinished) controller.abort();
  };
  ctx.res.on('close', onClose);
  try {
    const result = await pickDirectory(ctx.app.dirPicker, controller.signal);
    ctx.logFields.pickStatus = result.status;
    if (result.status !== 'aborted') sendJson(ctx.res, 200, result);
  } catch (err) {
    throw pickerHttpError(err);
  } finally {
    ctx.res.off('close', onClose);
  }
}

export const repoRoutes: Route[] = [
  { method: 'GET', pattern: '/api/repos', handler: listRepos, needsRepo: false },
  { method: 'POST', pattern: '/api/repo', handler: postRepo, needsRepo: false },
  { method: 'POST', pattern: '/api/repo/pick-dir', handler: pickDir, needsRepo: false },
  { method: 'DELETE', pattern: '/api/repos/recent', handler: deleteRecent, needsRepo: false },
];
