import type { Language } from '../model/language.js';
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

/**
 * 局部类型推断里还没确定的类型：从 root 出发依次取字段的类型。
 * root.type 为类型的 qualifiedName（`<包导入路径>.Type`）；root.ctor 为构造函数的 qualifiedName，取它的第一个返回类型
 */
export interface GoTypeChain {
  root: { type: string } | { ctor: string };
  fields: string[];
}

/** Go 的一个调用点 */
export interface GoCallSite {
  /** 调用所在的函数或方法符号；包级变量初始化里的调用为 module 符号 */
  callerId: string;
  /** 被调名字的位置，0 起始 */
  line: number;
  col: number;
  /** `foo()` 为 ident；`pkg.Foo()`（pkg 是 import 名）为 pkg；其他 `x.Foo()` 为 selector */
  form: 'ident' | 'pkg' | 'selector';
  name: string;
  /** form 为 pkg 时的 import 路径 */
  qualifier?: string;
  /** form 为 selector 时 x 的类型（类型的 qualifiedName），推断不出时为空 */
  receiverType?: string;
  /** x 的类型要跨文件才能确定时的推断线索，跨文件处理时据此填 receiverType */
  receiverChain?: GoTypeChain;
}

/** struct 的标签信息，数据模型识别用 */
export interface GoStructTags {
  /** 字段标签里出现的键，如 json、gorm、db */
  keys: string[];
  /** 嵌入了 gorm.Model */
  gormModel: boolean;
}

/** Go 文件的专用信息；全部是普通对象，提取缓存直接序列化 */
export interface GoFileFacts {
  /** 包导入路径 */
  packagePath: string;
  packageName: string;
  /** import 名 → import 路径；`_` 导入不在其中，`.` 导入在 dotImports */
  imports: Record<string, string>;
  dotImports: string[];
  calls: GoCallSite[];
  /** struct 符号 id → 标签信息；只记有标签或嵌入 gorm.Model 的 struct */
  structTags: Record<string, GoStructTags>;
  /** `os.Getenv` / `os.LookupEnv` 的字面量参数 */
  envReads: string[];
  /** 本文件 struct 的字段类型：类型名 → 字段名 → 字段类型的 qualifiedName（推断不出的字段不记） */
  structFields: Record<string, Record<string, string>>;
  /** 本文件包级函数的第一个返回类型：函数名 → 类型的 qualifiedName */
  funcResults: Record<string, string>;
}

export interface ExtractedFile {
  path: string;
  language: Language;
  /** 按出现顺序，第一个是 module 符号 */
  symbols: ExtractedSymbol[];
  entries: ExtractedEntry[];
  /** import 语句所在的行区间（0 起始，含两端） */
  importRows: [number, number][];
  /** Python 的 urls.py 里的路由；其他语言没有 */
  djangoRoutes?: DjangoRoute[];
  imports: Map<string, ImportBinding>;
  /** 模型识别用；从库里还原的文件没有 */
  classes?: ClassHint[];
  baseVars?: Map<string, BaseVarKind>;
  /** Go 文件的专用信息；其他语言没有 */
  go?: GoFileFacts;
}
