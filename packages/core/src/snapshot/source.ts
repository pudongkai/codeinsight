import { readFile, stat } from 'node:fs/promises';
import { sha1 } from '../extract/index.js';
import { log } from '../log.js';
import type { FileRow, SnapshotRow } from '../model/types.js';
import { snapshotDir, type DataDirLayout } from '../store/data-dir.js';
import type { Store } from '../store/db.js';
import { checkRelativePath, PathNotAllowedError, resolveInside } from '../util/paths.js';

/** 单个文件的读取上限 */
export const MAX_SOURCE_BYTES = 5 * 1024 * 1024;

/**
 * - `not_in_snapshot`：路径不在快照的文件清单里
 * - `not_found`：清单里有，但快照目录和工作区里都没有这个文件
 * - `file_changed`：从工作区读到的内容与建索引时的 content_hash 不一致
 * - `file_too_large`：超过读取上限
 */
export type SnapshotFileErrorCode = 'not_in_snapshot' | 'not_found' | 'file_changed' | 'file_too_large';

export class SnapshotFileError extends Error {
  constructor(
    readonly code: SnapshotFileErrorCode,
    readonly path: string,
  ) {
    super(`${code}: ${path}`);
  }
}

export interface SnapshotFileContext {
  /** 仓库根目录，工作区快照里不在快照目录的文件从这里读 */
  repo: string;
  store: Store;
  layout: DataDirLayout;
}

export interface ReadSnapshotFileOptions {
  /** 默认 MAX_SOURCE_BYTES */
  maxBytes?: number;
}

/** 实际读取的位置：快照目录里的副本，或工作区里的文件（读后要和 content_hash 比较） */
interface Located {
  file: string;
  from: 'snapshot' | 'working';
}

/**
 * 快照目录里的副本。副本不存在，或工作区快照的副本是指向快照目录外的符号链接时返回 undefined，
 * 改从工作区读；提交快照里指向快照目录外的链接直接拒绝。
 */
async function inSnapshotDir(ctx: SnapshotFileContext, snap: SnapshotRow, rel: string): Promise<string | undefined> {
  try {
    return await resolveInside(snapshotDir(ctx.layout, snap.contentKey), rel);
  } catch (err) {
    if (err instanceof PathNotAllowedError && snap.kind === 'working') return undefined;
    throw err;
  }
}

async function locate(ctx: SnapshotFileContext, snap: SnapshotRow, rel: string): Promise<Located> {
  const copy = await inSnapshotDir(ctx, snap, rel);
  if (copy) return { file: copy, from: 'snapshot' };
  // 工作区里的符号链接最终仍须落在仓库内
  const working = snap.kind === 'working' ? await resolveInside(ctx.repo, rel) : undefined;
  if (!working) throw new SnapshotFileError('not_found', rel);
  return { file: working, from: 'working' };
}

async function readLimited(file: string, rel: string, maxBytes: number): Promise<Buffer> {
  if ((await stat(file)).size > maxBytes) throw new SnapshotFileError('file_too_large', rel);
  return readFile(file);
}

function logRejected(snap: SnapshotRow, rel: string, err: unknown): void {
  if (err instanceof PathNotAllowedError) log.warn('snapshot_file_rejected', { snapshotId: snap.id, path: rel, reason: err.code });
  else if (err instanceof SnapshotFileError) log.info('snapshot_file_unavailable', { snapshotId: snap.id, path: rel, reason: err.code });
}

async function readChecked(ctx: SnapshotFileContext, snap: SnapshotRow, rel: string, maxBytes: number): Promise<string> {
  checkRelativePath(rel);
  const row = ctx.store.getFile(snap.id, rel);
  if (!row) throw new SnapshotFileError('not_in_snapshot', rel);
  return readRow(ctx, snap, row, maxBytes);
}

/** 读清单里的一个文件（行已查出）：快照副本或工作区 + content_hash 比较 */
async function readRow(ctx: SnapshotFileContext, snap: SnapshotRow, row: FileRow, maxBytes: number): Promise<string> {
  const rel = row.path;
  checkRelativePath(rel);
  const { file, from } = await locate(ctx, snap, rel);
  const data = await readLimited(file, rel, maxBytes);
  if (from === 'working' && sha1(data) !== row.contentHash) throw new SnapshotFileError('file_changed', rel);
  log.debug('snapshot_file_read', { snapshotId: snap.id, path: rel, from });
  return data.toString('utf8');
}

/**
 * 按快照读文件，内容与建索引时一致：
 * 1. 路径须在快照文件清单里且格式合法；
 * 2. 快照目录里有副本时读副本（提交快照的全部文件、工作区快照的支持语言文件和项目配置）；
 * 3. 工作区快照里没有副本的文件（README、SQL 等，以及指向快照目录外的符号链接）读工作区，内容变了返回 `file_changed`。
 * 抛 PathNotAllowedError（路径不允许访问）或 SnapshotFileError。
 */
export async function readSnapshotFile(ctx: SnapshotFileContext, snap: SnapshotRow, rel: string, opts: ReadSnapshotFileOptions = {}): Promise<string> {
  try {
    return await readChecked(ctx, snap, rel, opts.maxBytes ?? MAX_SOURCE_BYTES);
  } catch (err) {
    logRejected(snap, rel, err);
    throw err;
  }
}

/**
 * 同 readSnapshotFile，但文件行由调用方给出（已用 getFiles 一次查出），批量读多个文件时不再逐个查库。
 * row 必须来自同一快照的文件清单。
 */
export async function readSnapshotFileRow(ctx: SnapshotFileContext, snap: SnapshotRow, row: FileRow, opts: ReadSnapshotFileOptions = {}): Promise<string> {
  try {
    return await readRow(ctx, snap, row, opts.maxBytes ?? MAX_SOURCE_BYTES);
  } catch (err) {
    logRejected(snap, row.path, err);
    throw err;
  }
}

export interface LineRange {
  /** 从 1 开始，含两端 */
  start: number;
  end: number;
  totalLines: number;
  content: string;
}

/**
 * 取 start–end 行（含两端），end 超过总行数时截到末行、不传时到末行。
 * start 超过总行数时（链接里的行号比文件长）起点收到文件末尾，保持请求的行数；end 小于 start 时返回 undefined。
 */
export function sliceLines(text: string, start = 1, end?: number): LineRange | undefined {
  if (end !== undefined && end < start) return undefined;
  const lines = text.split(/\r?\n/);
  const total = lines.length;
  const from = start <= total ? start : Math.max(1, total - (end === undefined ? 0 : end - start));
  const last = Math.min(end ?? total, total);
  return { start: from, end: last, totalLines: total, content: lines.slice(from - 1, last).join('\n') };
}

/** 读文件失败的原因（错误码，或其他错误信息的第一行），用于日志 */
export function readFailureReason(err: unknown): string {
  if (err instanceof SnapshotFileError || err instanceof PathNotAllowedError) return err.code;
  return (err as Error).message.split('\n')[0] ?? 'unknown';
}
