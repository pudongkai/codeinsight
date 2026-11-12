import { api, ApiError } from '../api/client';
import type { SourceResponse, SymbolInfo } from '../api/types';
import { useApi } from '../browse/useApi';
import { callSites, type CallSite } from './call-sites';

/** 源码面板要显示的内容：快照里的符号 id，或按路径和行号定位的文件 */
export type SourceTarget =
  | { snapshotId: number; symbolId: string }
  | { snapshotId: number; path: string; start: number; end?: number };

export interface LoadedSource {
  /** 按路径打开时没有 */
  symbol?: SymbolInfo;
  source: SourceResponse;
  sites: CallSite[];
  /** 要突出显示的行（按路径打开时）；超出文件末尾的部分已截掉 */
  highlight?: { start: number; end: number };
  /** 按路径打开时目标行超出了文件实际行数（文件建索引后变短等），显示的是文件末尾 */
  beyondEnd?: { line: number };
}

export const FILE_CHANGED_MESSAGE = '文件在建索引后已修改，请重新建索引';

/** 源码面板的标识：换了目标时整个面板重新挂载 */
export function sourceKey(t: SourceTarget): string {
  return 'symbolId' in t ? `${t.snapshotId}:${t.symbolId}` : `${t.snapshotId}:${t.path}#${t.start}-${t.end ?? t.start}`;
}

/** 源码接口读的是建索引时的内容；工作区文件已改过时返回 409 file_changed，换成可读的提示 */
async function readSource(snapshotId: number, path: string, start?: number, end?: number): Promise<SourceResponse> {
  try {
    return await api.source(snapshotId, path, start, end);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && err.code === 'file_changed') throw new Error(FILE_CHANGED_MESSAGE);
    throw err;
  }
}

async function loadSymbol(snapshotId: number, symbolId: string): Promise<LoadedSource> {
  const { symbol } = await api.symbol(snapshotId, symbolId);
  const [source, callees] = await Promise.all([
    readSource(snapshotId, symbol.path, symbol.startLine, symbol.endLine),
    api.callees(snapshotId, symbol.id, 1),
  ]);
  return { symbol, source, sites: callSites(callees, symbol) };
}

/** 按路径打开时只读目标行前后这么多行，避免大文件整份读取和渲染 */
export const PATH_CONTEXT_LINES = 200;

/** 按路径打开：读目标行前后一段，突出显示目标行 */
async function load(t: SourceTarget): Promise<LoadedSource> {
  if ('symbolId' in t) return loadSymbol(t.snapshotId, t.symbolId);
  const end = Math.max(t.start, t.end ?? t.start);
  const source = await readSource(t.snapshotId, t.path, Math.max(1, t.start - PATH_CONTEXT_LINES), end + PATH_CONTEXT_LINES);
  if (t.start > source.totalLines) return { source, sites: [], beyondEnd: { line: t.start } };
  return { source, sites: [], highlight: { start: t.start, end: Math.min(end, source.totalLines) } };
}

/** 取源码（函数为整个函数加其中的调用点）；快照已清理时调用 onGone */
export function useSource(target: SourceTarget, onGone: () => void) {
  return useApi(() => load(target), [sourceKey(target)], onGone);
}
