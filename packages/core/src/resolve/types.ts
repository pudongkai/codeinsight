import type { DataDirLayout } from '../store/data-dir.js';
import type { EdgeRow } from '../model/types.js';
import type { ExtractedFile } from '../extract/types.js';

export interface ResolveInput {
  snapshotId: number;
  contentKey: string;
  /** 快照源码根目录 */
  root: string;
  layout: DataDirLayout;
  /** 本解析器负责的文件的提取结果，同时也是文件清单 */
  files: ExtractedFile[];
  timeoutMs: number;
  /** 中止时结束正在运行的外部进程并抛出异常 */
  signal?: AbortSignal;
}

export interface ResolveResult {
  edges: EdgeRow[];
  /** 不影响结果可用的问题（如提取层和解析层的定义对不上），记进快照行的 resolver_error */
  note?: string;
}

/** 解析器：把一个快照的引用关系转换成符号之间的边。失败时抛出异常，由快照流水线标记 resolver_status=failed */
export interface Resolver {
  readonly name: string;
  /** 解析代码和外部工具的版本标识；变了以后不再复用旧快照的调用边 */
  readonly version?: string;
  resolve(input: ResolveInput): Promise<ResolveResult>;
}
