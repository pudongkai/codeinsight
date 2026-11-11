import { readFile, stat } from 'node:fs/promises';
import { log, snapshotDir } from '@codeinsight/core';
import type { SnapshotRow } from '@codeinsight/core';
import type { Route, RequestContext } from '../context.js';
import { checkRelativePath, resolveInside } from '../paths.js';
import { HttpError, intParam, sendJson } from '../respond.js';
import { requireSnapshot } from '../snapshot.js';

const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_LINE = 10_000_000;

/**
 * 实际读取的文件：工作区快照读工作区里的文件（工作区里已删除时退回快照副本），提交快照读导出的快照目录。
 * 每一步都确认跟随符号链接后仍在对应根目录内。
 */
async function locate(ctx: RequestContext, snap: SnapshotRow, rel: string): Promise<string | undefined> {
  const { repo, layout } = ctx.app.ws;
  const snapRoot = snapshotDir(layout, snap.contentKey);
  if (snap.kind === 'working') return (await resolveInside(repo, rel)) ?? (await resolveInside(snapRoot, rel));
  return resolveInside(snapRoot, rel);
}

async function checkedPath(ctx: RequestContext, snap: SnapshotRow, rel: string): Promise<string> {
  try {
    checkRelativePath(rel);
    // 只允许快照文件清单里的路径
    if (!ctx.app.ws.store.getFile(snap.id, rel)) throw new HttpError(404, 'file_not_in_snapshot');
    const file = await locate(ctx, snap, rel);
    if (!file) throw new HttpError(404, 'file_not_found');
    return file;
  } catch (err) {
    if (err instanceof HttpError && err.status === 403) log.warn('source_path_rejected', { snapshotId: snap.id, path: rel, reason: err.code });
    throw err;
  }
}

/** GET /api/source?snapshot=&path=&start=&end=：源码片段，行号从 1 开始、含两端，不传时返回整个文件 */
async function source(ctx: RequestContext): Promise<void> {
  const q = ctx.url.searchParams;
  const snap = requireSnapshot(ctx, q.get('snapshot'));
  const rel = q.get('path') ?? '';
  const file = await checkedPath(ctx, snap, rel);
  if ((await stat(file)).size > MAX_SOURCE_BYTES) throw new HttpError(413, 'file_too_large');
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
  const start = intParam(q.get('start'), 'start', { min: 1, max: MAX_LINE, fallback: 1 })!;
  const end = Math.min(intParam(q.get('end'), 'end', { min: 1, max: MAX_LINE, fallback: lines.length })!, lines.length);
  if (end < start) throw new HttpError(400, 'invalid_param', 'end must not be less than start');
  sendJson(ctx.res, 200, { snapshotId: snap.id, path: rel, start, end, totalLines: lines.length, content: lines.slice(start - 1, end).join('\n') });
}

export const sourceRoutes: Route[] = [{ method: 'GET', pattern: '/api/source', handler: source }];
