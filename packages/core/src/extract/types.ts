import type { EntryKind, SymbolRow } from '../model/types.js';

/** 提取层的符号：入库字段之外，带名字标识符的位置，供 SCIP 定义对应到符号 */
export interface ExtractedSymbol extends Omit<SymbolRow, 'snapshotId'> {
  /** 名字标识符的位置，0 起始；module 符号为 0, 0 */
  nameLine: number;
  nameCol: number;
}

export interface ExtractedEntry {
  symbolId: string;
  kind: EntryKind;
  framework: string;
  detail: Record<string, unknown>;
}

/** Django urls.py 里的一条路由，处理函数要在全部文件提取完后跨文件查找 */
export interface DjangoRoute {
  /** 第二个参数的点分名字，`View.as_view()` 取 `View` */
  target: string[];
  detail: Record<string, unknown>;
}

/** import 别名：`from . import views` → views 指向模块；`from .views import index` → index 指向模块里的名字 */
export interface ImportBinding {
  module: string;
  name?: string;
}

export interface ExtractedFile {
  path: string;
  /** 按出现顺序，第一个是 module 符号 */
  symbols: ExtractedSymbol[];
  entries: ExtractedEntry[];
  /** import 语句所在的行区间（0 起始，含两端） */
  importRows: [number, number][];
  djangoRoutes: DjangoRoute[];
  imports: Map<string, ImportBinding>;
}
