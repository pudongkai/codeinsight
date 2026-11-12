import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { log } from '../log.js';
import type { SnapshotKind } from '../model/types.js';
import type { Warning } from '../report/types.js';
import { writeFileAtomic } from '../util/atomic-file.js';

/** 模块划分的阈值，规模都按非测试的 function、method、class 数计 */
export interface PartitionThresholds {
  /** 模块规模小于它时合并到兄弟模块 */
  moduleMinSize: number;
  /** 目录（含子目录）规模不超过它时整体作为一个模块 */
  moduleMaxSize: number;
  /** 一个目录直接放的文件规模超过它时才按文件拆 */
  leafSplitSize: number;
}

export const DEFAULT_PARTITION_THRESHOLDS: PartitionThresholds = { moduleMinSize: 8, moduleMaxSize: 300, leafSplitSize: 600 };

export type DirDecision = 'whole' | 'split';
/** 拆开的目录里直接放的文件：合成一个模块，还是按文件拆成几组 */
export type DirectDecision = 'files' | 'clusters';

export const PARTITION_RECORD_VERSION = 1;

/**
 * 划分记录：第一次划分的决定，之后只要目录、文件还在、规模没有超出记录规模的 0.5–2 倍就照记录来，
 * 不再看调用边，改代码不会让模块归属来回变。一个数据目录一份，所有 ref 共用。
 */
export interface PartitionRecord {
  version: number;
  thresholds: PartitionThresholds;
  /** 目录 → 整体 / 拆开；仓库根目录的 key 为 `.` */
  dirs: Record<string, DirDecision>;
  /** 拆开的目录 → 直接放的文件怎么分；做决定时的直接文件规模在 directSizes。旧记录没有这一项时按第一次判断 */
  direct?: Record<string, DirectDecision>;
  directSizes?: Record<string, number>;
  /** 模块 id → 合并目标模块 id，null 表示保持独立；做决定时的规模在 mergeSizes（只有 null 用到） */
  merges: Record<string, string | null>;
  mergeSizes?: Record<string, number>;
  /** 按文件拆开的目录里，文件路径 → 文件组模块 id */
  clusters: Record<string, string>;
  /** 目录或文件组做决定时的规模，只在重新判断时更新 */
  sizes: Record<string, number>;
  updatedAt: number;
  source?: { kind: SnapshotKind; commitSha: string };
}

export function partitionRecordPath(dataDir: string): string {
  return path.join(dataDir, 'overview', 'partition.json');
}

function isRecord(v: unknown): v is PartitionRecord {
  const r = v as PartitionRecord | null;
  return typeof r === 'object' && r !== null && r.version === PARTITION_RECORD_VERSION
    && typeof r.thresholds === 'object' && typeof r.dirs === 'object' && typeof r.merges === 'object'
    && typeof r.clusters === 'object' && typeof r.sizes === 'object';
}

/** 没有记录时返回 undefined；文件损坏或版本不认识时记日志并按没有记录处理（重新划分） */
export async function readPartitionRecord(dataDir: string): Promise<PartitionRecord | undefined> {
  const file = partitionRecordPath(dataDir);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    log.warn('partition_record_read_failed', { error: (err as Error).message.split('\n')[0] });
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) return parsed;
    log.warn('partition_record_invalid', { reason: 'unexpected format or version' });
  } catch (err) {
    log.warn('partition_record_invalid', { reason: (err as Error).message.split('\n')[0] });
  }
  return undefined;
}

/** 原子写入，并发的读方不会读到写了一半的记录；写失败记日志后抛出，由调用方决定是否影响结果 */
export async function writePartitionRecord(dataDir: string, record: PartitionRecord): Promise<void> {
  try {
    await writeFileAtomic(partitionRecordPath(dataDir), JSON.stringify(record, null, 2) + '\n');
    log.info('partition_record_written', { dirs: Object.keys(record.dirs).length, merges: Object.keys(record.merges).length, clusters: Object.keys(record.clusters).length });
  } catch (err) {
    log.error('partition_record_write_failed', { error: (err as Error).message.split('\n')[0] });
    throw err;
  }
}

/** 只取三个阈值：传入的可能是带其他概览配置的对象，记录里只存阈值 */
export function pickThresholds(t: PartitionThresholds): PartitionThresholds {
  return { moduleMinSize: t.moduleMinSize, moduleMaxSize: t.moduleMaxSize, leafSplitSize: t.leafSplitSize };
}

function sameThresholds(a: PartitionThresholds, b: PartitionThresholds): boolean {
  return a.moduleMinSize === b.moduleMinSize && a.moduleMaxSize === b.moduleMaxSize && a.leafSplitSize === b.leafSplitSize;
}

/** 阈值和记录里的不同时整份记录作废（按旧阈值做的决定不再成立），返回 info `partition_reset` */
export function applicableRecord(record: PartitionRecord | undefined, thresholds: PartitionThresholds): { record?: PartitionRecord; warnings: Warning[] } {
  if (!record) return { warnings: [] };
  if (sameThresholds(record.thresholds, thresholds)) return { record, warnings: [] };
  log.info('partition_reset', { recorded: record.thresholds, current: pickThresholds(thresholds) });
  return {
    warnings: [{
      code: 'partition_reset', level: 'info',
      message: 'module partition thresholds changed since the last overview; the partition record was ignored and modules were partitioned again',
    }],
  };
}

/** 新记录从旧记录复制：当前快照里不存在的路径保留但不使用 */
export function startRecord(base: PartitionRecord | undefined, thresholds: PartitionThresholds): PartitionRecord {
  return {
    version: PARTITION_RECORD_VERSION,
    thresholds: pickThresholds(thresholds),
    dirs: { ...base?.dirs },
    direct: { ...base?.direct },
    directSizes: { ...base?.directSizes },
    merges: { ...base?.merges },
    mergeSizes: { ...base?.mergeSizes },
    clusters: { ...base?.clusters },
    sizes: { ...base?.sizes },
    updatedAt: base?.updatedAt ?? 0,
    ...(base?.source ? { source: base.source } : {}),
  };
}

/** 当前规模在记录规模的 0.5–2 倍之间时沿用记录 */
export function withinRecordedRange(size: number, recorded: number): boolean {
  if (recorded === 0) return size === 0;
  return size >= recorded * 0.5 && size <= recorded * 2;
}

function sortedJson(r: Record<string, unknown> | undefined): string {
  return JSON.stringify(Object.keys(r ?? {}).sort().map((k) => [k, r![k]]));
}

/** 两份记录的决定是否相同（不比较 updatedAt、source） */
export function sameDecisions(a: PartitionRecord | undefined, b: PartitionRecord): boolean {
  if (!a || !sameThresholds(a.thresholds, b.thresholds)) return false;
  return (['dirs', 'direct', 'directSizes', 'merges', 'mergeSizes', 'clusters', 'sizes'] as const).every((k) => sortedJson(a[k]) === sortedJson(b[k]));
}
