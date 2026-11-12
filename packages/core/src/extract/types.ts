import type { EntryKind, ModelKind, SymbolRow } from '../model/types.js';

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

/** 一个类的基类和装饰器（点分名字列表），全部文件提取完后据此判断是不是数据模型类 */
export interface ClassHint {
  symbolId: string;
  bases: string[][];
  decorators: string[][];
}

/**
 * 模块顶层赋值得到、能当模型基类用的变量：
 * `Base = declarative_base()` 为 declarative（子类是 SQLAlchemy 模型），`db = SQLAlchemy()` 为 flask_db（`db.Model` 的子类是模型）
 */
export type BaseVarKind = 'declarative' | 'flask_db';

/** 模型识别的结果：kind 为类别；base 为 true 时类本身只是模型基类（如继承 DeclarativeBase 的 Base），不算模型，它的子类才算 */
export interface ModelMatch {
  kind: ModelKind;
  base: boolean;
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
  /** 模型识别用；从库里还原的文件没有 */
  classes?: ClassHint[];
  baseVars?: Map<string, BaseVarKind>;
}
