import type { Language } from '../model/language.js';
import type { EntryKind, ModelKind, SymbolRow } from '../model/types.js';
import type { RustTargetKind } from './rust-cargo.js';

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

/** 按名字引用的函数或方法：函数名（ident）、`pkg.Func`（pkg）、方法值 `h.Create`（selector），规则同调用点 */
export type GoFuncRef = Pick<GoCallSite, 'form' | 'name' | 'qualifier' | 'receiverType' | 'receiverChain'>;

/** 处理函数：按名字引用，或已建了符号的函数字面量 */
export type GoHandlerRef = GoFuncRef | { symbolId: string };

/** 一条路由注册，处理函数在跨文件处理时查找 */
export interface GoRoute {
  framework: 'net/http' | 'gin' | 'echo' | 'chi';
  /** 请求方法（大写）；net/http 的路由模式里没写方法时为空 */
  method?: string;
  /** 本函数里能看到的路由分组前缀加上注册的路径 */
  path: string;
  handler: GoHandlerRef;
}

/** 一个 `cobra.Command` 字面量，处理函数为 Run 或 RunE */
export interface GoCobraCommand {
  use: string;
  handler: GoHandlerRef;
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
  /** 路由注册（net/http、gin、echo、chi） */
  routes?: GoRoute[];
  /** cobra 命令 */
  cobraCommands?: GoCobraCommand[];
}

/** 源码里的一个位置，0 起始 */
export interface RustPosition {
  line: number;
  col: number;
}

/** 类型上的 derive 和其他属性，数据模型识别用 */
export interface RustDerives {
  /** derive 名（路径取最后一段），如 Serialize、FromRow */
  derives: string[];
  /** derive 以外的属性路径，如 diesel、serde、sea_orm */
  attrs: string[];
}

/**
 * 一条写在源码里的路径，在所在文件里解析：`self`/`super` 开头的已换成 `crate` 开头；
 * mod 为路径所在的内联 mod（相对文件模块，如 `mod tests {}` 里为 ["tests"]），不在内联 mod 里时没有
 */
export interface RustPathRef {
  segments: string[];
  mod?: string[];
}

/**
 * 局部类型推断里还没确定的类型：从 root 出发依次取字段的类型。
 * root.type 为类型的路径；root.call 为被调函数的路径，取它的返回类型。路径都在调用点所在文件和内联 mod 里解析
 */
export interface RustTypeChain {
  root: { type: string[] } | { call: string[] };
  fields: string[];
}

/** Rust 的一个调用点 */
export interface RustCallSite {
  /** 调用所在的函数或方法符号 */
  callerId: string;
  /** 被调名字（路径最后一段或方法名）的位置，0 起始 */
  line: number;
  col: number;
  /** `foo()`、`a::b::foo()`、`Type::new()`、`Self::m()` 为 path；`x.m()` 为 method */
  form: 'path' | 'method';
  /** path 为完整路径（去掉 turbofish，`Self` 换成 impl 的类型）；method 为 [方法名] */
  segments: string[];
  /** 调用所在的内联 mod（相对文件模块）；不在内联 mod 里时没有 */
  mod?: string[];
  /** method 形式 x 的类型（类型符号 id），跨文件处理时由 receiverChain 算出；推断不出时为空 */
  receiverType?: string;
  /** method 形式 x 的类型线索 */
  receiverChain?: RustTypeChain;
}

/** Rust 路由的处理函数：写在源码里的路径，或已建了符号的闭包 */
export type RustHandlerRef = RustPathRef | { symbolId: string };

/** 一条 Rust 路由，处理函数在跨文件处理时查找 */
export interface RustRoute {
  framework: 'axum' | 'actix-web' | 'rocket';
  /** 请求方法（大写）；没限定方法时为空 */
  method?: string;
  /** 同一函数里能看到的前缀加上注册的路径 */
  path: string;
  handler: RustHandlerRef;
}

/** rocket 的 `.mount("/api", routes![a, b])` */
export interface RustMount {
  prefix: string;
  handlers: RustPathRef[];
}

/** 一个模块（文件模块或内联 mod）里的 use 绑定 */
export interface RustUseScope {
  uses: Record<string, string[]>;
  globUses: string[][];
  pubUses: Record<string, string[]>;
}

/** Rust 文件的专用信息；全部是普通对象，提取缓存直接序列化 */
export interface RustFileFacts {
  /** crate 名（`-` 换成 `_`） */
  crate: string;
  /** 所属 crate 目标的根文件路径（区分 lib、各 bin、各集成测试） */
  target: string;
  /** 所属 crate 目标的种类；不在任何目标里的文件没有 */
  targetKind?: RustTargetKind;
  /** 文件的模块路径，如 ["order", "service"] */
  modulePath: string[];
  /** 文件模块里的 use 绑定：名字 → 完整路径（`self`/`super` 开头的已换成 `crate` 开头；glob 不在其中） */
  uses: Record<string, string[]>;
  /** 文件模块里 `use x::*` 的模块路径 */
  globUses: string[][];
  /** 文件模块里 `pub use` 的再导出：名字 → 完整路径 */
  pubUses: Record<string, string[]>;
  /** 内联 mod 里的 use：mod 路径（相对文件模块，`::` 连接）→ 绑定；没有时不记 */
  modUses?: Record<string, RustUseScope>;
  /** 调用点 */
  calls: RustCallSite[];
  /** struct 符号 id → 字段名 → 字段类型路径（推断不出的字段不记） */
  structFields: Record<string, Record<string, RustPathRef>>;
  /** 函数或方法符号 id → 返回类型路径（`Self` 已换成 impl 的类型；推断不出的不记） */
  fnResults: Record<string, RustPathRef>;
  /** 文件里的内联 mod（相对文件模块的路径） */
  inlineMods: string[][];
  /** impl 方法符号 id → impl 目标类型的路径，跨文件处理时据此找父符号 */
  implTypes: Record<string, RustPathRef>;
  /** 每个 use 路径最后一段的位置；`use x::*` 取 x 的位置 */
  useLeaves: RustPosition[];
  /** `mod x;` 声明所在行 */
  modDecls: number[];
  /** 类型符号 id → derive 和属性；只记有 derive 或属性的类型 */
  derives: Record<string, RustDerives>;
  /** 路径表达式、宏路径、属性路径、use 路径的第一段（去重） */
  pathRoots: string[];
  /** 环境变量读取的字面量参数 */
  envReads: string[];
  /** 项级宏调用的行范围（含两端） */
  macroRanges: [number, number][];
  /** 所在包的目录；不在任何包里时没有 */
  packageDir?: string;
  /** 路由（axum、actix-web、rocket） */
  routes?: RustRoute[];
  /** rocket 的 mount 前缀 */
  mounts?: RustMount[];
  /** clap 子命令名 */
  clapCommands?: string[];
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
  /** Rust 文件的专用信息；其他语言没有 */
  rust?: RustFileFacts;
}
