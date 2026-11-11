import { commitMessages } from '../git/index.js';
import { log } from '../log.js';
import type { ReviewReport, SymbolChange, Warning } from '../report/types.js';
import type { Store } from '../store/db.js';
import { fileChanges, groupByModule, resolverWarnings, symbolChange, unsupportedWarnings, type SymbolFacts } from './assemble.js';
import { callerSummaries, edgeChanges, impactSummaries, loadGraphSide, type GraphSide } from './impact.js';
import { diffSymbols, type SymbolDiff } from './symbol-diff.js';
import { changedFiles, prepareSnapshots, resolveVersions, type PreparedSnapshots, type ReviewOptions, type Versions } from './versions.js';

export { EMPTY_BASE_REF, ReviewArgsError, type ReviewOptions } from './versions.js';
export { callerSummaries, impactSummaries, loadGraphSide, type GraphSide } from './impact.js';
export { diffSymbols, pathSimilarity, MOVED_MIN_SIMILARITY, type SymbolDiff } from './symbol-diff.js';
export { moduleOf } from './assemble.js';

/** 改动文件（含重命名前的旧路径）里的非 module 符号；module 符号只用于归属顶层代码的边，不列入改动清单 */
function changedSymbols(side: GraphSide, paths: Set<string>) {
  return [...side.symbols.values()].filter((s) => s.kind !== 'module' && paths.has(s.path));
}

function runDiff(store: Store, base: GraphSide, head: GraphSide, paths: Set<string>): SymbolDiff[] {
  return diffSymbols({
    base: changedSymbols(base, paths),
    head: changedSymbols(head, paths),
    loadTokens: (side, ids) => {
      const snapshotId = side === 'base' ? base.snapshotId : head.snapshotId;
      return new Map(store.getSymbolsByIds(snapshotId, ids, { withTokens: true }).map((s) => [s.id, s.normTokens]));
    },
  });
}

/** 调用方和影响面：removed 在 base 图上查，其余在 head 图上查；每个方向一次批量遍历 */
function symbolFacts(diffs: SymbolDiff[], base: GraphSide, head: GraphSide, impactDepth: number): SymbolFacts {
  const baseIds = diffs.filter((d) => d.change === 'removed').map((d) => d.base!.id);
  const headIds = diffs.filter((d) => d.change !== 'removed').map((d) => d.head!.id);
  return {
    base, head, impactDepth,
    callers: { base: callerSummaries(base, baseIds), head: callerSummaries(head, headIds) },
    impact: { base: impactSummaries(base, baseIds, impactDepth), head: impactSummaries(head, headIds, impactDepth) },
  };
}

function countChanges(changes: SymbolChange[]): Record<string, number> {
  const counts: Record<string, number> = { added: 0, removed: 0, modified: 0, signature_changed: 0, moved: 0 };
  for (const c of changes) counts[c.change] = (counts[c.change] ?? 0) + 1;
  return counts;
}

async function intentFromCommits(v: Versions): Promise<ReviewReport['intent']> {
  if (v.head.working || v.base.sha === v.head.sha) return undefined;
  const text = await commitMessages(v.root, v.base.sha, v.head.sha);
  return text ? { source: 'commits', text } : undefined;
}

function snapshotWarnings(snaps: PreparedSnapshots): Warning[] {
  const base = snaps.base ? resolverWarnings('base', snaps.base) : [];
  const head = snaps.head && snaps.head.id !== snaps.base?.id ? resolverWarnings('head', snaps.head) : [];
  return [...base, ...head];
}

interface Analysis {
  modules: ReviewReport['modules'];
  edgeChanges: ReviewReport['edgeChanges'];
}

function analyze(opts: ReviewOptions, snaps: PreparedSnapshots, paths: Set<string>): Analysis {
  const base = loadGraphSide(opts.store, snaps.base);
  const head = loadGraphSide(opts.store, snaps.head);
  const diffs = runDiff(opts.store, base, head, paths);
  const facts = symbolFacts(diffs, base, head, opts.config.impactDepth);
  const changes = diffs.map((d) => symbolChange(d, facts));
  const edges = edgeChanges(diffs, base, head);
  log.info('review_diff', { ...countChanges(changes), edgeChanges: edges.length, baseResolved: base.resolved, headResolved: head.resolved });
  return { modules: groupByModule(changes, opts.config.moduleDepth), edgeChanges: edges };
}

/** warning 级逐条记录；提示级按 code 汇总条数，避免不支持语言的文件很多时刷屏 */
function logWarnings(warnings: Warning[]): void {
  const infoCounts = new Map<string, number>();
  for (const w of warnings) {
    if (w.level === 'warning') log.warn('review_warning', { code: w.code, side: w.side, path: w.path, message: w.message.split('\n')[0] });
    else infoCounts.set(w.code, (infoCounts.get(w.code) ?? 0) + 1);
  }
  for (const [code, count] of infoCounts) log.info('review_notice', { code, count });
}

/**
 * 审查两个版本之间的改动（review 流程第 1–7、10 步）：确定版本和改动文件 → 两个版本并行准备快照 →
 * 函数级 diff → 调用方、影响面和边变化 → 按模块分组 → 组装报告。解析失败不算错误，写进 warnings。
 */
export async function runReview(opts: ReviewOptions): Promise<ReviewReport> {
  const started = Date.now();
  const progress = opts.onProgress ?? (() => undefined);
  const v = await resolveVersions(opts);
  log.info('review_start', { base: v.base.ref, baseSha: v.base.sha, head: v.head.ref, headSha: v.head.sha, working: v.head.working });
  const changed = await changedFiles(v, opts.config);
  const files = fileChanges(changed, { testGlobs: opts.config.testGlobs, generatedGlobs: opts.config.generatedGlobs });
  progress('snapshots');
  const snaps = await prepareSnapshots(opts, v, changed);
  const snapshotsMs = Date.now() - started;
  progress('analysis');
  const paths = new Set(changed.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path])));
  const analysis = analyze(opts, snaps, paths);
  const warnings = [...snapshotWarnings(snaps), ...unsupportedWarnings(files)];
  logWarnings(warnings);
  const intent = await intentFromCommits(v);
  const totalMs = Date.now() - started;
  log.info('review_done', { files: files.length, modules: analysis.modules.length, warnings: warnings.length, snapshotsMs, totalMs });
  return {
    schemaVersion: 1,
    repo: v.root,
    base: { ref: v.base.ref, sha: v.base.sha, snapshotId: snaps.base?.id ?? null },
    head: { ...v.head, snapshotId: snaps.head?.id ?? null },
    ...(intent ? { intent } : {}),
    files,
    modules: analysis.modules,
    edgeChanges: analysis.edgeChanges,
    duplicates: [],
    warnings,
    timings: { totalMs, snapshotsMs, analysisMs: totalMs - snapshotsMs },
  };
}
