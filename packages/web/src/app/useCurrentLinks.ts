import { useState } from 'react';
import { api, ApiError, errorMessage } from '../api/client';
import type { SymbolInfo } from '../api/types';
import { useNav, type GraphOptions } from './nav';

export const SYMBOL_MISSING = '该符号在当前代码中已不存在';
export const FILE_MISSING = '该文件在当前代码中已不存在';

/** 要打开的符号：概览和问答里只有符号 id，名字用于提示 */
export interface SymbolLinkTarget {
  id: string;
  qualifiedName: string;
}

const currentSymbol = (snap: number, id: string) => api.symbol(snap, id).then((d): SymbolInfo => d.symbol);

/** 文件在不在当前快照里；文件建索引后被改过（409）时仍然打开，由源码面板说明 */
async function checkFile(snap: number, path: string): Promise<void> {
  try {
    await api.source(snap, path, 1, 1);
  } catch (err) {
    if (!(err instanceof ApiError && err.code === 'file_changed')) throw err;
  }
}

/**
 * 概览、问答里的符号和源码位置都按当前快照打开（符号 id 跨快照稳定）。
 * 打开前先在当前快照里查一次：符号或文件已不存在时给出提示、不跳转；410 走页面级的快照失效处理。
 * 跳转用当前快照里查到的位置，不用生成时记录的行号。
 */
export function useCurrentLinks(snapshotId: number | undefined) {
  const nav = useNav();
  const [notice, setNotice] = useState<string>();

  const run = async <T,>(load: (snap: number) => Promise<T>, missing: string, open: (snap: number, data: T) => void) => {
    if (snapshotId === undefined) return setNotice('索引还没建好，稍后再试');
    setNotice(undefined);
    try {
      open(snapshotId, await load(snapshotId));
    } catch (err) {
      if (err instanceof ApiError && err.snapshotGone) return nav.snapshotGone();
      setNotice(err instanceof ApiError && err.status === 404 ? missing : `打开失败：${errorMessage(err)}`);
    }
  };
  const symbolMissing = (t: SymbolLinkTarget) => `${SYMBOL_MISSING}：${t.qualifiedName}`;

  return {
    notice,
    clearNotice: () => setNotice(undefined),
    openSymbol: (t: SymbolLinkTarget) =>
      void run((snap) => currentSymbol(snap, t.id), symbolMissing(t), (snap, s) =>
        nav.openSymbol({ snapshotId: snap, id: s.id, name: s.qualifiedName, path: s.path, line: s.startLine })),
    openGraph: (t: SymbolLinkTarget, opts?: GraphOptions) =>
      void run((snap) => currentSymbol(snap, t.id), symbolMissing(t), (snap, s) =>
        nav.openGraph({ snapshotId: snap, id: s.id, name: s.qualifiedName }, 'browse', opts)),
    openSourceAt: (path: string, start: number, end?: number) =>
      void run((snap) => checkFile(snap, path), `${FILE_MISSING}：${path}`, (snap) => nav.openSourceAt({ snapshotId: snap, path, start, end })),
  };
}

export type CurrentLinks = ReturnType<typeof useCurrentLinks>;
