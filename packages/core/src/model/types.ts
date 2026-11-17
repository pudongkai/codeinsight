import type { Language, SupportLevel } from './language.js';

export type SnapshotKind = 'commit' | 'working';
export type StepStatus = 'pending' | 'ok' | 'failed' | 'skipped';

/** 名称匹配的原因：找不到外部工具、外部工具运行失败、选项关闭、项目里没有 go.mod（装了工具也用不上） */
export type FallbackReason = 'not_found' | 'failed' | 'disabled' | 'no_module';

/** 一种语言的调用边来自哪里：scip 索引、名称匹配，或这种语言解析失败（其他语言的边照常入库） */
export interface EdgeSource {
  source: 'scip' | 'name_match' | 'failed';
  /** source 为 name_match 时的原因 */
  reason?: FallbackReason;
  /** 回退或失败发生的时间（毫秒时间戳） */
  at?: number;
  /** 原因说明的第一行 */
  note?: string;
}

/** 各语言调用边的来源；旧快照没有记录时为 null，按全部来自 scip 处理 */
export type EdgeSources = Partial<Record<Language, EdgeSource>>;

export interface SnapshotRow {
  id: number;
  kind: SnapshotKind;
  commitSha: string;
  contentKey: string;
  extractStatus: StepStatus;
  resolverStatus: StepStatus;
  /** 失败原因、跳过原因；ok 时为解析结果的提示（如 SCIP 定义对不上的比例），没有时为 null */
  resolverError: string | null;
  edgeSources: EdgeSources | null;
  createdAt: number;
  lastUsedAt: number;
}

export interface FileRow {
  snapshotId: number;
  path: string;
  language: Language;
  supportLevel: SupportLevel;
  contentHash: string;
  isTest: boolean;
  isGenerated: boolean;
}

export interface SymbolRow {
  snapshotId: number;
  id: string;
  symbolKey: string;
  kind: string;
  name: string;
  qualifiedName: string;
  signature: string;
  displaySignature: string;
  parentId: string | null;
  path: string;
  startLine: number;
  endLine: number;
  bodyHash: string;
  normTokens: string[];
  docstring: string | null;
  isTest: boolean;
  isGenerated: boolean;
  /** 数据模型类的类别（见 ModelKind），不是模型或不是类时为 null */
  modelKind: ModelKind | null;
}

/**
 * 数据模型类的来源：pydantic BaseModel、SQLModel、SQLAlchemy 声明式模型（含 Flask-SQLAlchemy db.Model）、
 * Django models.Model、TypedDict、NamedTuple、dataclass、attrs。继承项目内模型类的子类沿用基类的类别。
 * Go 的 struct 按字段标签分：gorm（gorm 标签或嵌入 gorm.Model）、sqlx（db 标签）、json（只有 json 标签）
 */
export type ModelKind =
  | 'pydantic' | 'sqlmodel' | 'sqlalchemy' | 'django' | 'typeddict' | 'namedtuple' | 'dataclass' | 'attrs'
  | 'gorm' | 'sqlx' | 'json';

export type EdgeKind = 'call' | 'reference' | 'import' | 'inherit' | 'implement' | 'dispatch' | 'route_handler';
export type Provenance = 'scip' | 'psi' | 'name_match' | 'framework';

export interface EdgeRow {
  snapshotId: number;
  srcId: string;
  dstId: string;
  kind: EdgeKind;
  provenance: Provenance;
  confidence: 'high' | 'low';
  path: string;
  line: number;
  col: number;
}

export type EntryKind = 'http' | 'exception_handler' | 'task' | 'cli' | 'schedule' | 'event';

export interface EntryRow {
  snapshotId: number;
  symbolId: string;
  kind: EntryKind;
  framework: string;
  detail: Record<string, unknown>;
}

export type ReviewStatus = 'running' | 'done' | 'failed';

export interface ReviewRow {
  id: number;
  params: Record<string, unknown>;
  status: ReviewStatus;
  /** ReviewReport JSON */
  report: unknown;
  error: string | null;
  progress: string | null;
  createdAt: number;
}
