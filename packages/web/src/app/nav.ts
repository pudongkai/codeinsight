import { createContext, useContext } from 'react';

/** 打开某个快照里的函数 */
export interface SymbolLocator {
  snapshotId: number;
  id: string;
  name: string;
  path: string;
  line: number;
  removed?: boolean;
}

/** 页面级导航：浏览视图、审查页和源码面板之间跳转 */
export interface Nav {
  /** 点击函数：有 JS 桥时在 IDE 中打开，否则（或 removed 函数）在源码面板显示 */
  openSymbol(s: SymbolLocator): void;
  /** 只在页面里显示源码 */
  showSource(s: SymbolLocator): void;
  /** 打开邻居图，origin 为 review 时快照被清理按审查报告的方式提示 */
  openGraph(s: Pick<SymbolLocator, 'snapshotId' | 'id' | 'name'>, origin?: 'browse' | 'review'): void;
  /** 接口返回 410 snapshot_gone */
  snapshotGone(): void;
  /** 接口返回 503 index_not_ready */
  indexNotReady(): void;
}

export const NavContext = createContext<Nav | undefined>(undefined);

export function useNav(): Nav {
  const nav = useContext(NavContext);
  if (!nav) throw new Error('NavContext missing');
  return nav;
}
