import type { Language, SupportLevel } from './language.js';

export type SnapshotKind = 'commit' | 'working';
export type StepStatus = 'pending' | 'ok' | 'failed' | 'skipped';

export interface SnapshotRow {
  id: number;
  kind: SnapshotKind;
  commitSha: string;
  contentKey: string;
  extractStatus: StepStatus;
  resolverStatus: StepStatus;
  /** 失败原因、跳过原因；ok 时为解析结果的提示（如 SCIP 定义对不上的比例），没有时为 null */
  resolverError: string | null;
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
 * Django models.Model、TypedDict、NamedTuple、dataclass、attrs。继承项目内模型类的子类沿用基类的类别
 */
export type ModelKind = 'pydantic' | 'sqlmodel' | 'sqlalchemy' | 'django' | 'typeddict' | 'namedtuple' | 'dataclass' | 'attrs';

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
