/**
 * 审查报告 JSON（ReviewReport）：CLI、HTTP、MCP、Web UI 共用。
 * 本文件只有类型，不依赖 Node 模块，web 可以直接引用 `@codeinsight/core/report/types`。
 */

export const REPORT_SCHEMA_VERSION = 1;

/** 单文件 HTML 报告里内嵌报告 JSON 的 `<script type="application/json">` 元素 id（cli 写入，web 读取） */
export const EMBEDDED_REPORT_ELEMENT_ID = 'codeinsight-report';

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
  /** 数据模型类的类别（pydantic、sqlalchemy、django、dataclass 等），不是模型时不存在 */
  modelKind?: string;
  /** 入口信息（只在调用方列表和调用边变化里给出），界面据此标出 HTTP 接口 */
  entry?: EntryInfo;
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
  /** 数据模型类的类别，不是模型时不存在 */
  modelKind?: string;
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

/** 重复实现：symbol 为新增或搬家的函数（全库扫描时为任一函数），candidates 按 score 从高到低，最多 3 个 */
export interface DuplicateFinding {
  symbol: SymbolRef;
  /** reasons 写明命中的项，如 `same name`、`similar body (0.82)`、`same signature shape` */
  candidates: { symbol: SymbolRef; score: number; reasons: string[] }[];
}

/** 意图偏离：LLM 把改动分组后的一组；symbols 只含改动清单里的符号，modules 为这些符号所在模块 */
export interface IntentFinding {
  verdict: 'mentioned' | 'unmentioned' | 'unclear';
  summary: string;
  symbols: SymbolRef[];
  modules: string[];
}

export type WarningCode =
  | 'resolver_failed'
  | 'resolver_note'
  | 'language_unsupported'
  | 'llm_not_configured'
  | 'llm_disabled'
  | 'llm_failed'
  | 'llm_invalid_response'
  | 'llm_truncated'
  | 'intent_missing'
  | 'intent_truncated'
  | 'intent_no_symbols'
  | 'config_llm_key_ignored'
  | (string & {});

/**
 * 出现这些 code 时意图检查没有给出结果，界面用它们说明没做检查的原因。
 * intent_truncated 只是部分符号没发送、检查仍有结果，config_llm_key_ignored 是配置提示，都不在其中。
 */
export const INTENT_SKIP_CODES: readonly WarningCode[] = [
  'llm_not_configured',
  'llm_disabled',
  'llm_failed',
  'llm_invalid_response',
  'llm_truncated',
  'intent_missing',
  'intent_no_symbols',
];

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
  /** 函数级 diff、调用方、影响面、边变化、重复实现和意图偏离 */
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
  /** 未配置 LLM、加了 --no-llm、没有意图文本或 LLM 调用失败时不存在，原因见 warnings */
  intentCheck?: IntentFinding[];
  warnings: Warning[];
  timings?: ReviewTimings;
}
