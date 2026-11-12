import type { CodeInsightConfig } from '../config/index.js';
import { sha1 } from '../extract/python.js';
import { log } from '../log.js';
import type { FileRow, SnapshotRow, SymbolRow } from '../model/types.js';
import type { Warning } from '../report/types.js';
import { readSnapshotFileRow, SnapshotFileError, type SnapshotFileContext } from '../snapshot/source.js';
import type { DataDirLayout } from '../store/data-dir.js';
import type { Store } from '../store/db.js';
import { boundaryIssues, moduleLayers } from './boundary.js';
import { collectExternal } from './external.js';
import { externalTable } from './external-table.js';
import {
  buildGraph, httpApisByModule, moduleDirs, moduleEdges, moduleInterfaces, moduleLines, moduleModels, overviewStats, rankedOwnModels,
  rankedOwnSymbols, type OverviewGraph,
} from './facts.js';
import { groupFeatures } from './features.js';
import { defaultModuleName } from './module-id.js';
import { loadPartitionInput, partition, type PartitionModule, type PartitionResult } from './partition.js';
import { pickThresholds, readPartitionRecord, type PartitionRecord } from './partition-state.js';
import { modelHeads, moduleSnippets, type Snippet, type SnippetLimits } from './snippets.js';
import type {
  BoundaryIssue, ExternalCategorySummary, Feature, ModuleEdge, OverviewModule, OverviewReport, OverviewStats,
} from './types.js';

export interface StructureOptions {
  repo: string;
  store: Store;
  layout: DataDirLayout;
  snapshot: SnapshotRow;
  config: Pick<CodeInsightConfig, 'dataDir' | 'overview'>;
  /** 不传时用配置里的 overview.snippets */
  snippetLimits?: SnippetLimits;
}

/** 概览的结构部分（第 1–8 步），估算、生成、MCP 共用；缓存里的对象，使用方不要修改 */
export interface OverviewStructure {
  snapshot: SnapshotRow;
  partition: PartitionResult;
  graph: OverviewGraph;
  /** 名称为默认名，aiStatus 为 none */
  modules: OverviewModule[];
  moduleEdges: ModuleEdge[];
  external: ExternalCategorySummary[];
  features: Feature[];
  issues: BoundaryIssue[];
  stats: OverviewStats;
  /** 模块 id → 公开符号和 HTTP 接口（按 rankedOwnSymbols 的顺序） */
  ranked: Map<string, SymbolRow[]>;
  /** 模块 id → 源码片段 */
  snippets: Map<string, Snippet[]>;
  /** 模块 id → 模块摘要输入用的数据模型（只按本模块内的引用排序，见 rankedOwnModels） */
  ownModels: Map<string, SymbolRow[]>;
  /** 模块 id → ownModels 里各类的前几行 */
  modelHeads: Map<string, Snippet[]>;
  warnings: Warning[];
}

/** 进程内只缓存最近 2 份结构结果 */
const CACHE_SIZE = 2;
const cache = new Map<string, Promise<OverviewStructure>>();

function cacheKey(opts: StructureOptions, record: PartitionRecord | undefined): string {
  const cfg = JSON.stringify({ overview: opts.config.overview, snippets: opts.snippetLimits ?? opts.config.overview.snippets });
  return [opts.snapshot.contentKey, sha1(JSON.stringify(record ?? null)), sha1(cfg)].join(':');
}

type ModuleFacts = Pick<OverviewModule, 'external' | 'envVars' | 'layers' | 'httpApis'>;

function overviewModule(g: OverviewGraph, m: PartitionModule, facts: ModuleFacts): OverviewModule {
  return {
    id: m.id, dirs: moduleDirs(m), files: m.files, size: m.size, lines: moduleLines(g, m),
    name: defaultModuleName(m.id), aiStatus: 'none',
    interfaces: moduleInterfaces(g, m.id), models: moduleModels(g, m.id), ...facts,
  };
}

/**
 * 整个结构计算共用的读文件函数：文件行从已查出的清单里取（不逐个查库），同一文件只读一次。
 * 不在清单里的路径按 not_in_snapshot 处理。
 */
function snapshotReader(ctx: SnapshotFileContext, snapshot: SnapshotRow, files: readonly FileRow[]): (path: string) => Promise<string> {
  const rows = new Map(files.map((f) => [f.path, f]));
  const texts = new Map<string, Promise<string>>();
  return (path) => {
    let text = texts.get(path);
    if (!text) {
      const row = rows.get(path);
      text = row ? readSnapshotFileRow(ctx, snapshot, row) : Promise.reject(new SnapshotFileError('not_in_snapshot', path));
      texts.set(path, text);
    }
    return text;
  };
}

async function rankAndSnippets(
  g: OverviewGraph, modules: OverviewModule[], read: (p: string) => Promise<string>, limits: SnippetLimits,
): Promise<Pick<OverviewStructure, 'ranked' | 'snippets' | 'ownModels' | 'modelHeads'>> {
  const ranked = new Map<string, SymbolRow[]>();
  const snippets = new Map<string, Snippet[]>();
  const ownModels = new Map<string, SymbolRow[]>();
  const heads = new Map<string, Snippet[]>();
  for (const m of modules) {
    ranked.set(m.id, rankedOwnSymbols(g, m.id));
    ownModels.set(m.id, rankedOwnModels(g, m.id));
    snippets.set(m.id, await moduleSnippets(m.id, ranked.get(m.id)!, read, limits));
    heads.set(m.id, await modelHeads(m.id, ownModels.get(m.id)!, read));
    await new Promise((r) => setImmediate(r));
  }
  return { ranked, snippets, ownModels, modelHeads: heads };
}

async function compute(opts: StructureOptions, record: PartitionRecord | undefined): Promise<OverviewStructure> {
  const started = Date.now();
  const { store, snapshot, config } = opts;
  const input = loadPartitionInput(store, snapshot.id);
  const p = partition({ ...input, thresholds: pickThresholds(config.overview), record, source: { kind: snapshot.kind, commitSha: snapshot.commitSha } });
  const g = buildGraph(p.modules, p.index, { ...input, entries: store.getEntries(snapshot.id) });
  const edges = moduleEdges(g);
  const read = snapshotReader({ repo: opts.repo, store, layout: opts.layout }, snapshot, input.files);
  const ext = await collectExternal({ modules: p.modules, files: input.files, read, table: externalTable(config.overview.externalCategories) });
  const boundary = boundaryIssues(g, edges, config.overview.layers);
  const http = httpApisByModule(g);
  const modules = p.modules.map((m) => overviewModule(g, m, {
    ...(ext.byModule.get(m.id) ?? { external: [], envVars: [] }), layers: moduleLayers(m.files, boundary.layers), httpApis: http.get(m.id) ?? 0,
  }));
  const s: OverviewStructure = {
    snapshot, partition: p, graph: g, modules, moduleEdges: edges, external: ext.summary, features: groupFeatures(g),
    issues: boundary.issues, stats: overviewStats(g, p.stats.files, p.stats.testFiles),
    ...(await rankAndSnippets(g, modules, read, opts.snippetLimits ?? opts.config.overview.snippets)),
    warnings: [...p.warnings, ...ext.warnings, ...boundary.warnings],
  };
  log.info('overview_structure_done', { snapshotId: snapshot.id, modules: modules.length, edges: edges.length, features: s.features.length, issues: s.issues.length, ms: Date.now() - started });
  return s;
}

/**
 * 计算概览的结构部分（不调用 LLM、不写划分记录）。读当前的划分记录；
 * 进程内按 (content_key, 划分记录内容 hash, 配置 hash) 缓存最近 2 份。
 */
export async function computeStructure(opts: StructureOptions): Promise<OverviewStructure> {
  const record = await readPartitionRecord(opts.config.dataDir);
  const key = cacheKey(opts, record);
  let hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    log.debug('overview_structure_cache_hit', { snapshotId: opts.snapshot.id });
  } else {
    hit = compute(opts, record);
    hit.catch(() => cache.delete(key));
  }
  cache.set(key, hit);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return hit;
}

export interface StructureReportMeta {
  repo: string;
  ref: string;
  now?: number;
}

/** 只有结构部分的概览（没有 llm、system，名称为默认名）；返回的对象是副本，可以修改 */
export function structureReport(s: OverviewStructure, meta: StructureReportMeta): OverviewReport {
  const { contentKey, commitSha, kind, createdAt } = s.snapshot;
  return structuredClone({
    schemaVersion: 1, repo: meta.repo, ref: meta.ref,
    snapshot: { contentKey, commitSha, kind, createdAt },
    generatedAt: meta.now ?? Date.now(),
    stats: s.stats, modules: s.modules, moduleEdges: s.moduleEdges, external: s.external,
    features: s.features, issues: s.issues,
    ai: { calls: 0, cached: 0, failed: 0, inputTokens: 0, outputTokens: 0 },
    warnings: s.warnings,
  });
}
