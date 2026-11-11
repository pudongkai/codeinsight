/**
 * 审查报告 JSON（ReviewReport）：CLI、HTTP、MCP、Web UI 共用。
 * 本文件只有类型，不依赖 Node 模块，web 可以直接引用 `@codeinsight/core/report/types`。
 */

export const REPORT_SCHEMA_VERSION = 1;

export type FileChangeStatus = 'added' | 'removed' | 'modified' | 'renamed';
export type SymbolChangeKind = 'added' | 'removed' | 'modified' | 'signature_changed' | 'moved';

export interface SymbolRef {
  key: string;
  /** 所在快照里的符号 id，配合 base/head 的 snapshotId 查调用方详情 */
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  path: string;
  startLine: number;
  isTest: boolean;
}

export interface FileChange {
  path: string;
  /** renamed 时的旧路径 */
  oldPath?: string;
  status: FileChangeStatus;
  language: string;
  supportLevel: 'full' | 'structure' | 'none';
  additions: number;
  deletions: number;
  isTest: boolean;
}

export interface EntryInfo {
  kind: string;
  framework: string;
  detail: Record<string, unknown>;
}

export interface CallerSummary {
  prod: number;
  test: number;
  /** 正式代码调用方，按调用点数量从多到少取前 5 个 */
  topProd: SymbolRef[];
}

export interface ImpactSummary {
  depth: number;
  prod: number;
  test: number;
}

export interface SymbolChange {
  key: string;
  /** 符号所在快照（removed 为 base，其余为 head）里的 id */
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  path: string;
  startLine: number;
  endLine: number;
  isTest: boolean;
  change: SymbolChangeKind;
  /** removed 取 base，其余取 head */
  displaySignature: string;
  /** modified / moved 且 display_signature 变化时给出旧值 */
  displaySignatureBefore?: string;
  /** moved 时为 base 里的 symbol_key */
  movedFrom?: string;
  entry?: EntryInfo;
  /** 取 head；removed 取 base。解析失败时为 0，见 warnings */
  callers: CallerSummary;
  impact: ImpactSummary;
}

export interface ModuleChange {
  module: string;
  symbols: SymbolChange[];
}

export interface EdgeChange {
  src: SymbolRef;
  dst: SymbolRef;
  kind: string;
  change: 'added' | 'removed';
}

export interface DuplicateFinding {
  symbol: SymbolRef;
  candidates: { symbol: SymbolRef; score: number; reasons: string[] }[];
}

export interface IntentFinding {
  verdict: 'mentioned' | 'unmentioned' | 'unclear';
  summary: string;
  symbols: SymbolRef[];
  modules: string[];
}

export type WarningCode = 'resolver_failed' | 'resolver_note' | 'language_unsupported' | 'llm_not_configured' | (string & {});

export interface Warning {
  code: WarningCode;
  /** warning 影响结果；info 只是提示 */
  level: 'warning' | 'info';
  message: string;
  /** 和某个文件相关时给出（如 language_unsupported） */
  path?: string;
  /** 和某个版本的快照相关时给出（如 resolver_failed） */
  side?: 'base' | 'head';
}

export interface ReviewTimings {
  totalMs: number;
  /** 两个版本快照的准备（构建或复用） */
  snapshotsMs: number;
  /** 函数级 diff、调用方、影响面和边变化 */
  analysisMs: number;
}

export interface ReviewReport {
  schemaVersion: 1;
  repo: string;
  /**
   * head 是首个提交时 ref 为 `(empty tree)`、sha 为空树。
   * snapshotId 为 null：没有构建快照（与空树比较，或改动里没有支持结构分析的语言）
   */
  base: { ref: string; sha: string; snapshotId: number | null };
  /** working 时 sha 为当时的 HEAD */
  head: { ref: string; sha: string; working: boolean; snapshotId: number | null };
  intent?: { source: 'arg' | 'file' | 'commits'; text: string };
  /** 全部改动文件，含不支持的语言 */
  files: FileChange[];
  /** 按模块分组的函数级改动 */
  modules: ModuleChange[];
  edgeChanges: EdgeChange[];
  duplicates: DuplicateFinding[];
  /** 未配置 LLM 时不存在 */
  intentCheck?: IntentFinding[];
  warnings: Warning[];
  timings?: ReviewTimings;
}
