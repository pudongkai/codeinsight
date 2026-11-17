import type { DataDirLayout } from '../store/data-dir.js';
import type { Language } from '../model/language.js';
import type { EdgeRow, EdgeSource, EdgeSources } from '../model/types.js';
import type { ExtractedFile } from '../extract/types.js';

export type { EdgeSource, EdgeSources };

export interface ResolveInput {
  snapshotId: number;
  contentKey: string;
  /** 快照源码根目录 */
  root: string;
  layout: DataDirLayout;
  /** 本解析器负责的文件的提取结果，同时也是文件清单 */
  files: ExtractedFile[];
  timeoutMs: number;
  /** scip-go 的超时；不传时用 timeoutMs */
  goTimeoutMs?: number;
  /** rust-analyzer 的超时（所有运行根目录共用）；不传时用 timeoutMs */
  rustTimeoutMs?: number;
  /** 中止时结束正在运行的外部进程并抛出异常 */
  signal?: AbortSignal;
}

/** 一种语言解析失败（其他语言的边照常返回） */
export interface FailedLanguage {
  language: Language;
  reason: string;
}

export interface ResolveResult {
  edges: EdgeRow[];
  /** 不影响结果可用的问题（如提取层和解析层的定义对不上），记进快照行的 resolver_error */
  note?: string;
  /** 各语言的边来自哪里；不给时按全部来自 scip 处理 */
  sources?: EdgeSources;
  /** 实际生效的版本（如回退到名称匹配时为 name-match）；不给时等于 version */
  effectiveVersion?: string;
  /** 解析失败的语言；有值时快照标记 resolver_status=failed，但 edges 照常入库 */
  failed?: FailedLanguage[];
}

/** 解析器：把一个快照的引用关系转换成符号之间的边。失败时抛出异常，由快照流水线标记 resolver_status=failed */
export interface Resolver {
  readonly name: string;
  /** 解析代码和外部工具的版本标识；变了以后不再复用旧快照的调用边。prepare 之后读取 */
  readonly version?: string;
  /**
   * 解析和复用判断之前调用一次，传入本快照出现的语言：查找外部工具、确定 version。
   * 一个实例只用于一次构建，prepare 的结果决定之后 version、resolve 的行为
   */
  prepare?(languages: Language[]): Promise<void>;
  resolve(input: ResolveInput): Promise<ResolveResult>;
  /**
   * 解析成功但部分语言的边来自名称匹配的快照，现在是否应该重新解析（如之前找不到的工具现在找到了）。
   * 调用前已经 prepare 过；不实现时不重新解析
   */
  needsReresolve?(sources: EdgeSources): Promise<boolean>;
}
