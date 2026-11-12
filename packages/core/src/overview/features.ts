import { log } from '../log.js';
import { entryText, isHttpApi } from '../model/entry.js';
import type { EntryRow } from '../model/types.js';
import { pushTo } from '../util/collections.js';
import { fileStem } from '../util/paths.js';
import { moduleOfSymbol, refOf, type OverviewGraph } from './facts.js';
import type { Feature, FeatureEntry } from './types.js';
import { compareStrings } from '../util/compare.js';

/** 同一文件里的 HTTP 接口超过这个数时按路径第一段细分 */
export const FEATURE_SPLIT_THRESHOLD = 8;

/** 非 HTTP 接口的入口按 kind 分组时的默认名称；FastAPI 中间件的 kind 也是 http */
const KIND_NAMES: Record<string, string> = {
  schedule: '定时任务', cli: '命令行', task: '异步任务', event: '事件处理', exception_handler: '异常处理', http: '中间件',
};

/** 路径第一段：路径参数（`{id}`、`<int:id>`、`:id`）、`api`、`v1` 这类段跳过；没有时为空串 */
export function firstPathSegment(routePath: string): string {
  for (const seg of routePath.split('/')) {
    if (seg === '' || /^[{<:]/.test(seg) || /^api$/i.test(seg) || /^v\d+$/i.test(seg)) continue;
    return seg;
  }
  return '';
}

function featureEntry(g: OverviewGraph, e: EntryRow): FeatureEntry {
  const method = entryText(e, 'method');
  const p = entryText(e, 'path');
  return { symbol: refOf(g, g.symbols.get(e.symbolId)!), kind: e.kind, ...(method ? { method } : {}), ...(p ? { path: p } : {}) };
}

function byKey(a: FeatureEntry, b: FeatureEntry): number {
  return compareStrings(a.symbol.key, b.symbol.key);
}

/** id = 模块 id + 组内按 key 排序后第一个入口的符号 id */
export function makeFeature(module: string, name: string, entries: FeatureEntry[], description?: string): Feature {
  const sorted = [...entries].sort(byKey);
  return { id: `${module}:${sorted[0]!.symbol.id}`, module, name, ...(description ? { description } : {}), entries: sorted };
}

/** 一个文件里的 HTTP 接口：不超过阈值时一组，否则按路径第一段分组 */
function httpFileGroups(module: string, file: string, entries: FeatureEntry[]): Feature[] {
  const stem = fileStem(file);
  const bySeg = new Map<string, FeatureEntry[]>();
  for (const e of entries) {
    const seg = firstPathSegment(e.path ?? '');
    pushTo(bySeg, seg, e);
  }
  const label = (seg: string) => (seg ? `${stem} /${seg}` : stem);
  if (entries.length <= FEATURE_SPLIT_THRESHOLD) return [makeFeature(module, label(bySeg.size === 1 ? [...bySeg.keys()][0]! : ''), entries)];
  return [...bySeg].sort(([a], [b]) => compareStrings(a, b)).map(([seg, list]) => makeFeature(module, label(seg), list));
}

function moduleFeatures(g: OverviewGraph, module: string, entries: EntryRow[]): Feature[] {
  const httpByFile = new Map<string, FeatureEntry[]>();
  const byKind = new Map<string, FeatureEntry[]>();
  for (const e of entries) {
    const fe = featureEntry(g, e);
    const [map, key] = isHttpApi(e) ? [httpByFile, fe.symbol.path] : [byKind, e.kind];
    pushTo(map, key, fe);
  }
  const out: Feature[] = [];
  for (const [file, list] of [...httpByFile].sort(([a], [b]) => compareStrings(a, b))) out.push(...httpFileGroups(module, file, list));
  for (const [kind, list] of [...byKind].sort(([a], [b]) => compareStrings(a, b))) out.push(makeFeature(module, KIND_NAMES[kind] ?? kind, list));
  return out;
}

/**
 * 功能分组（第 7 步，不用 LLM）：入口先按模块分开；HTTP 接口按处理函数所在文件分组，
 * 同一文件超过 8 个时按路径第一段细分；其他入口按 kind 分组。每个入口符号只出现一次。
 */
export function groupFeatures(g: OverviewGraph): Feature[] {
  const byModule = new Map<string, EntryRow[]>();
  for (const e of g.entries.values()) {
    const m = moduleOfSymbol(g, e.symbolId);
    if (m !== undefined && !g.symbols.get(e.symbolId)!.isTest) pushTo(byModule, m, e);
  }
  const out = [...byModule].sort(([a], [b]) => compareStrings(a, b)).flatMap(([m, list]) => moduleFeatures(g, m, list));
  log.info('overview_features_grouped', { modules: byModule.size, features: out.length });
  return out;
}

/** LLM 返回的功能命名 */
export interface NamedFeature {
  name: string;
  description?: string;
  entryKeys: string[];
}

/**
 * 把 LLM 的功能命名套到一个模块的默认分组上：不在输入里的 key 丢弃，同一个入口出现在多个功能里时只保留第一个，
 * 没覆盖到的入口按默认分组补回（用默认名称）。
 */
export function applyFeatureNames(module: string, defaults: Feature[], named: NamedFeature[]): Feature[] {
  const byKey = new Map(defaults.flatMap((f) => f.entries.map((e) => [e.symbol.key, e] as const)));
  const used = new Set<string>();
  const out: Feature[] = [];
  let dropped = 0;
  for (const nf of named) {
    const entries: FeatureEntry[] = [];
    for (const key of nf.entryKeys) {
      const e = byKey.get(key);
      if (!e) dropped++;
      else if (!used.has(key)) {
        used.add(key);
        entries.push(e);
      }
    }
    if (entries.length > 0) out.push(makeFeature(module, nf.name, entries, nf.description));
  }
  for (const f of defaults) {
    const rest = f.entries.filter((e) => !used.has(e.symbol.key));
    if (rest.length > 0) out.push(makeFeature(module, f.name, rest, f.description));
  }
  if (dropped > 0) log.info('overview_feature_keys_dropped', { module, dropped });
  return out;
}
