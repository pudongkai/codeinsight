import { isTestPath, type ClassifyOptions } from '../classify/index.js';
import type { ChangedFile } from '../git/index.js';
import { detectLanguage, supportLevelOf, type SupportLevel } from '../model/language.js';
import type { FileRow, SnapshotRow } from '../model/types.js';
import type { Store } from '../store/db.js';
import type { CallerSummary, FileChange, ImpactSummary, ModuleChange, SymbolChange, Warning } from '../report/types.js';
import { EMPTY_CALLERS, type GraphSide } from './impact.js';
import type { SymbolDiff } from './symbol-diff.js';

/** 改动文件在快照里记录的支持级别：删除的文件看 base 快照，其余看 head 快照；快照里没有时为 undefined */
export type SnapshotSupportLevels = (f: ChangedFile) => SupportLevel | undefined;

/** 从两个版本的快照读出各文件的支持级别（每个快照只查一次） */
export function snapshotSupportLevels(store: Store, snaps: { base?: SnapshotRow; head?: SnapshotRow }): SnapshotSupportLevels {
  const levels = (snap: SnapshotRow | undefined): Map<string, SupportLevel> =>
    new Map(snap ? store.getFiles(snap.id).map((r: FileRow) => [r.path, r.supportLevel]) : []);
  const base = levels(snaps.base);
  const head = snaps.head?.id === snaps.base?.id ? base : levels(snaps.head);
  return (f) => (f.status === 'removed' ? base : head).get(f.path);
}

/**
 * 改动文件列表；支持级别优先用快照里已算好的（Rust 的 target/、vendor/ 排除要用完整文件清单），
 * 快照里查不到时按路径计算
 */
export function fileChanges(files: ChangedFile[], classify: ClassifyOptions, levels?: SnapshotSupportLevels): FileChange[] {
  return files
    .map((f): FileChange => {
      const language = detectLanguage(f.path);
      return {
        path: f.path,
        ...(f.oldPath !== undefined ? { oldPath: f.oldPath } : {}),
        status: f.status,
        language,
        supportLevel: levels?.(f) ?? supportLevelOf(language, f.path),
        additions: f.additions,
        deletions: f.deletions,
        isTest: isTestPath(f.path, classify),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** 模块 = 文件所在目录的前 depth 层；仓库根目录下的文件归到 `.` */
export function moduleOf(filePath: string, depth: number): string {
  const dirs = filePath.split('/').slice(0, -1);
  return dirs.length === 0 ? '.' : dirs.slice(0, depth).join('/');
}

export interface SymbolFacts {
  base: GraphSide;
  head: GraphSide;
  callers: { base: Map<string, CallerSummary>; head: Map<string, CallerSummary> };
  impact: { base: Map<string, ImpactSummary>; head: Map<string, ImpactSummary> };
  impactDepth: number;
}

/** removed 取 base 的符号和图，其余取 head */
export function symbolChange(d: SymbolDiff, facts: SymbolFacts): SymbolChange {
  const onBase = d.change === 'removed';
  const s = onBase ? d.base! : d.head!;
  const side = onBase ? 'base' : 'head';
  const before = d.base?.displaySignature;
  const entry = facts[side].entries.get(s.id);
  return {
    key: s.symbolKey, id: s.id, kind: s.kind, name: s.name, qualifiedName: s.qualifiedName,
    path: s.path, startLine: s.startLine, endLine: s.endLine, isTest: s.isTest,
    change: d.change,
    displaySignature: s.displaySignature,
    ...(!onBase && d.base && before !== s.displaySignature ? { displaySignatureBefore: before } : {}),
    ...(d.change === 'moved' ? { movedFrom: d.base!.symbolKey } : {}),
    ...(entry ? { entry } : {}),
    ...(s.modelKind ? { modelKind: s.modelKind } : {}),
    callers: facts.callers[side].get(s.id) ?? EMPTY_CALLERS,
    impact: facts.impact[side].get(s.id) ?? { depth: facts.impactDepth, prod: 0, test: 0 },
  };
}

export function groupByModule(changes: SymbolChange[], depth: number): ModuleChange[] {
  const byModule = new Map<string, SymbolChange[]>();
  for (const c of changes) {
    const m = moduleOf(c.path, depth);
    byModule.set(m, [...(byModule.get(m) ?? []), c]);
  }
  return [...byModule.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([module, symbols]) => ({ module, symbols: symbols.sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine) }));
}

/** 解析失败（resolver_failed）和解析提示（resolver_note，如 SCIP 定义对不上的比例）来自快照行 */
export function resolverWarnings(side: 'base' | 'head', snap: SnapshotRow): Warning[] {
  if (snap.resolverStatus === 'failed') {
    const reason = snap.resolverError ?? 'unknown error';
    return [{ code: 'resolver_failed', level: 'warning', side, message: `call graph unavailable for ${side} (${snap.commitSha.slice(0, 12)}): ${reason}` }];
  }
  if (snap.resolverStatus === 'ok' && snap.resolverError) {
    return [{ code: 'resolver_note', level: 'info', side, message: snap.resolverError }];
  }
  return [];
}

export function unsupportedWarnings(files: FileChange[]): Warning[] {
  return files
    .filter((f) => f.supportLevel === 'none')
    .map((f): Warning => ({
      code: 'language_unsupported', level: 'info', path: f.path,
      message: `structure analysis is not supported for ${f.language === 'unknown' ? 'this file type' : f.language}; listed as a file-level change only`,
    }));
}
