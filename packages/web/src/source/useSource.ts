import { api } from '../api/client';
import type { SourceResponse, SymbolInfo } from '../api/types';
import { useApi } from '../browse/useApi';
import { callSites, type CallSite } from './call-sites';

/** 源码面板要显示的函数：快照里的符号 id */
export interface SourceTarget {
  snapshotId: number;
  symbolId: string;
}

export interface LoadedSource {
  symbol: SymbolInfo;
  source: SourceResponse;
  sites: CallSite[];
}

async function load(t: SourceTarget): Promise<LoadedSource> {
  const { symbol } = await api.symbol(t.snapshotId, t.symbolId);
  const [source, callees] = await Promise.all([
    api.source(t.snapshotId, symbol.path, symbol.startLine, symbol.endLine),
    api.callees(t.snapshotId, symbol.id, 1),
  ]);
  return { symbol, source, sites: callSites(callees, symbol) };
}

/** 取整个函数的源码和其中的调用点；快照已清理时调用 onGone */
export function useSource(target: SourceTarget, onGone: () => void) {
  return useApi(() => load(target), [target.snapshotId, target.symbolId], onGone);
}
