import { useEffect, useState } from 'react';
import { ApiError, api, errorMessage } from '../api/client';
import type { SourceResponse, SymbolInfo } from '../api/types';
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
  const [state, setState] = useState<{ data?: LoadedSource; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    let cancelled = false;
    setState({ loading: true });
    load(target).then(
      (data) => !cancelled && setState({ data, loading: false }),
      (err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.snapshotGone) onGone();
        setState({ error: `读取源码失败：${errorMessage(err)}`, loading: false });
      },
    );
    return () => {
      cancelled = true;
    };
    // onGone 每次渲染都是新函数，只在目标变化时重新加载
  }, [target.snapshotId, target.symbolId]);
  return state;
}
