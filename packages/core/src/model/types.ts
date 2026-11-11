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
  /** 失败原因或跳过原因 */
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
}

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
