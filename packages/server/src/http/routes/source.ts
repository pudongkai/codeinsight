import { readSnapshotFile, sliceLines, SnapshotFileError } from '@codeinsight/core';
import type { SnapshotFileErrorCode, SnapshotRow } from '@codeinsight/core';
import type { Route, RequestContext } from '../context.js';
import { pathErrorToHttp } from '../paths.js';
import { HttpError, intParam, sendJson } from '../respond.js';
import { requireSnapshot } from '../snapshot.js';

const MAX_LINE = 10_000_000;

/** 读文件失败的 HTTP 状态和错误码 */
const FILE_ERRORS: Record<SnapshotFileErrorCode, [number, string]> = {
  not_in_snapshot: [404, 'file_not_in_snapshot'],
  not_found: [404, 'file_not_found'],
  file_changed: [409, 'file_changed'],
  file_too_large: [413, 'file_too_large'],
};

function toHttpError(err: unknown): unknown {
  if (err instanceof SnapshotFileError) {
    const [status, code] = FILE_ERRORS[err.code];
    return new HttpError(status, code);
  }
  return pathErrorToHttp(err);
}

async function readFileText(ctx: RequestContext, snap: SnapshotRow, rel: string): Promise<string> {
  const { repo, store, layout } = ctx.app.ws;
  try {
    return await readSnapshotFile({ repo, store, layout }, snap, rel);
  } catch (err) {
    throw toHttpError(err);
  }
}

/** GET /api/source?snapshot=&path=&start=&end=：按快照读源码，行号从 1 开始、含两端，不传时返回整个文件 */
async function source(ctx: RequestContext): Promise<void> {
  const q = ctx.url.searchParams;
  const snap = requireSnapshot(ctx, q.get('snapshot'));
  const rel = q.get('path') ?? '';
  const text = await readFileText(ctx, snap, rel);
  const start = intParam(q.get('start'), 'start', { min: 1, max: MAX_LINE, fallback: 1 })!;
  const end = intParam(q.get('end'), 'end', { min: 1, max: MAX_LINE });
  const range = sliceLines(text, start, end);
  if (!range) throw new HttpError(400, 'invalid_param', 'end must not be less than start');
  sendJson(ctx.res, 200, { snapshotId: snap.id, path: rel, ...range });
}

export const sourceRoutes: Route[] = [{ method: 'GET', pattern: '/api/source', handler: source }];
