/** HTTP API 的响应形状（与 packages/server/src/http/routes 一致） */
import type { ReviewReport } from '@codeinsight/core/report/types';

export interface SymbolInfo {
  id: string;
  key: string;
  kind: string;
  name: string;
  qualifiedName: string;
  displaySignature: string;
  path: string;
  startLine: number;
  endLine: number;
  isTest: boolean;
  /** 数据模型类的类别（pydantic、sqlalchemy 等），不是模型时不存在 */
  modelKind?: string;
  /** 入口信息（有多个时优先 HTTP 入口），不是入口时不存在 */
  entry?: { kind: string; framework: string; detail: Record<string, unknown> };
}

export interface IndexJobView {
  id: number;
  reason: string;
  status: 'running' | 'done' | 'failed';
  snapshotId?: number;
  cached?: boolean;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface SnapshotView {
  id: number;
  kind: 'commit' | 'working';
  commitSha: string;
  createdAt: number;
  resolverStatus: string;
  resolverError: string | null;
}

export type ReviewStatus = 'running' | 'done' | 'failed';

export interface ReviewParams {
  base?: string;
  head?: string;
  working?: boolean;
  intent?: string;
  noLlm?: boolean;
}

export interface ReviewSummary {
  id: number;
  params: ReviewParams;
  status: ReviewStatus;
  error: string | null;
  progress: string | null;
  createdAt: number;
}

export interface StatusResponse {
  repo: string;
  node: string;
  llmConfigured: boolean;
  index: { job: IndexJobView | null; lastDoneAt: number | null };
  snapshot: SnapshotView | null;
  reviews: ReviewSummary[];
}

export interface ReviewResponse {
  id: number;
  status: ReviewStatus;
  progress: string | null;
  params: ReviewParams;
  createdAt: number;
  error?: string;
  report?: ReviewReport;
}

export interface EntryItem {
  kind: string;
  framework: string;
  detail: Record<string, unknown>;
  symbol: SymbolInfo;
}

export interface TreeEdge {
  srcId: string;
  dstId: string;
  kind: string;
  path: string;
  line: number;
  /** 从 0 开始 */
  col: number;
}

export interface TreeResponse {
  snapshotId: number;
  resolverStatus: string;
  direction: 'callers' | 'callees';
  depth: number;
  root: SymbolInfo;
  nodes: (SymbolInfo & { depth: number })[];
  edges: TreeEdge[];
}

export interface NeighborCounts {
  total: number;
  prod: number;
  test: number;
}

export interface SymbolDetail {
  snapshotId: number;
  resolverStatus: string;
  symbol: SymbolInfo & { docstring: string | null; parent: SymbolInfo | null };
  entries: { kind: string; framework: string; detail: Record<string, unknown> }[];
  callers: NeighborCounts;
  callees: NeighborCounts;
}

export interface SourceResponse {
  snapshotId: number;
  path: string;
  start: number;
  end: number;
  totalLines: number;
  content: string;
}
