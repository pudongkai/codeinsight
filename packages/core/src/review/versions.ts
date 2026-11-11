import type { CodeInsightConfig } from '../config/index.js';
import { diffCommits, diffWorking, emptyTreeSha, hasParent, repoRoot, resolveRef, type ChangedFile } from '../git/index.js';
import { isSupported } from '../model/language.js';
import { log } from '../log.js';
import type { SnapshotRow } from '../model/types.js';
import type { Resolver } from '../resolve/types.js';
import { buildSnapshot, excludeDirs, type BuildSnapshotResult } from '../snapshot/build.js';
import type { DataDirLayout } from '../store/data-dir.js';
import type { Store } from '../store/db.js';

export interface ReviewOptions {
  repo: string;
  store: Store;
  layout: DataDirLayout;
  config: CodeInsightConfig;
  /** 默认：审查工作区时为 HEAD，审查提交时为 `<head>~1`；head 是首个提交时为空树 */
  base?: string;
  /** 提交 ref；不传时默认 HEAD（working 为 false 时）或审查工作区 */
  head?: string;
  /** 不传时：没有 head 就审查工作区；显式 false 且没有 head 时审查提交 HEAD */
  working?: boolean;
  /** 默认 ScipPythonResolver */
  resolver?: Resolver;
  /** 进度回调（HTTP 异步审查任务用） */
  onProgress?: (step: string) => void;
}

export interface Versions {
  root: string;
  /** empty：head 是首个提交且没指定 base，与空树比较，没有 base 快照 */
  base: { ref: string; sha: string; empty: boolean };
  head: { ref: string; sha: string; working: boolean };
}

export class ReviewArgsError extends Error {}

/** base 显示用的 ref：与空树比较时 */
export const EMPTY_BASE_REF = '(empty tree)';

async function resolveBase(opts: ReviewOptions, root: string, head: { ref: string; sha: string; working: boolean }): Promise<Versions['base']> {
  if (opts.base !== undefined) return { ref: opts.base, sha: await resolveRef(root, opts.base), empty: false };
  if (head.working) return { ref: 'HEAD', sha: head.sha, empty: false };
  if (await hasParent(root, head.sha)) {
    const ref = `${head.ref}~1`;
    return { ref, sha: await resolveRef(root, ref), empty: false };
  }
  return { ref: EMPTY_BASE_REF, sha: await emptyTreeSha(root), empty: true };
}

/** 解析 base、head 为 sha；working 未指定且没有 head 时审查工作区 */
export async function resolveVersions(opts: ReviewOptions): Promise<Versions> {
  if (opts.head !== undefined && opts.working) throw new ReviewArgsError('--head and --working cannot be used together');
  const root = await repoRoot(opts.repo);
  const working = opts.working ?? opts.head === undefined;
  const headRef = opts.head ?? 'HEAD';
  const headSha = await resolveRef(root, headRef);
  const head = { ref: working ? 'WORKING' : headRef, sha: headSha, working };
  return { root, base: await resolveBase(opts, root, { ...head, ref: headRef }), head };
}

export async function changedFiles(v: Versions, config: CodeInsightConfig): Promise<ChangedFile[]> {
  if (!v.head.working) return diffCommits(v.root, v.base.sha, v.head.sha);
  return diffWorking(v.root, v.base.sha, excludeDirs(config, v.root));
}

function logSnapshot(side: 'base' | 'head', r: BuildSnapshotResult): void {
  const s = r.snapshot;
  log.info('review_snapshot', {
    side, snapshotId: s.id, contentKey: s.contentKey, cached: r.cached, resolveRetried: r.resolveRetried, resolverStatus: s.resolverStatus,
  });
}

export interface PreparedSnapshots {
  /** 没有构建时（与空树比较、改动里没有支持的语言）为 undefined，按空快照处理 */
  base?: SnapshotRow;
  head?: SnapshotRow;
}

/**
 * 两个版本并行走快照构建流水线；base 和 head 是同一个提交时只构建一次。
 * 改动文件里没有支持结构分析的语言时两个都不构建，报告只有文件级改动。
 */
export async function prepareSnapshots(opts: ReviewOptions, v: Versions, changed: ChangedFile[]): Promise<PreparedSnapshots> {
  if (!changed.some((f) => isSupported(f.path) || (f.oldPath !== undefined && isSupported(f.oldPath)))) {
    log.info('review_snapshots_skipped', { reason: 'no changed files in a supported language', files: changed.length });
    return {};
  }
  const build = (ref: string | undefined) =>
    buildSnapshot({ repo: v.root, store: opts.store, layout: opts.layout, config: opts.config, ref, resolver: opts.resolver });
  const sameCommit = !v.head.working && v.base.sha === v.head.sha;
  const [base, head] = await Promise.all([
    v.base.empty ? undefined : build(v.base.sha),
    sameCommit ? undefined : build(v.head.working ? undefined : v.head.sha),
  ]);
  if (base) logSnapshot('base', base);
  if (head) logSnapshot('head', head);
  return { base: base?.snapshot, head: (head ?? base)?.snapshot };
}
