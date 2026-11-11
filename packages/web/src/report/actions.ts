/** 报告里点击某个函数时的目标：side 是它所在的版本（removed 和被删除的边在 base，其余在 head） */
export interface SymbolTarget {
  side: 'base' | 'head';
  id: string;
  name: string;
  path: string;
  startLine: number;
  removed: boolean;
}

/** serve 页面给报告视图提供的能力；HTML 单文件报告不提供（没有 API） */
export interface ReportActions {
  /** 在页面里显示源码（已确认没有 JS 桥或是 removed 函数） */
  showSource(target: SymbolTarget): void;
  /** 打开该函数的邻居图 */
  openGraph(target: SymbolTarget): void;
}
