import { httpRoute, isHttpApi } from '../model/entry.js';
import type { EntryRow, SnapshotRow, SymbolRow } from '../model/types.js';
import type { OverviewReport } from '../overview/types.js';
import type { EntryInfo } from '../report/types.js';
import type { DataDirLayout } from '../store/data-dir.js';
import type { Store } from '../store/db.js';

/** 问答工具的执行环境：都只读、都作用于当前快照 */
export interface AskToolContext {
  repo: string;
  store: Store;
  layout: DataDirLayout;
  snapshot: SnapshotRow;
  /** false 时 read_source、grep_code 不返回代码 */
  sendSource: boolean;
  /** 当前概览；没有时 get_module 返回 overview_missing，符号不带所属模块 */
  overview?: OverviewReport;
  /** 中止时逐个读文件的工具（grep_code）在读完当前文件后停下 */
  signal?: AbortSignal;
}

/** 一次工具调用的结果：返回给模型的文字，以及其中出现的符号（收集成回答的 refs） */
export interface ToolOutput {
  content: string;
  symbols: SymbolRow[];
  /** 符号 id → 入口信息，refs 据此标出 HTTP 接口 */
  entries: Map<string, EntryInfo>;
}

const moduleMaps = new WeakMap<OverviewReport, Map<string, string>>();

/** 文件所属模块（来自当前概览）；没有概览或文件不在任何模块里时为 undefined */
export function moduleOfPath(ctx: AskToolContext, path: string): string | undefined {
  const r = ctx.overview;
  if (!r) return undefined;
  let map = moduleMaps.get(r);
  if (!map) {
    map = new Map(r.modules.flatMap((m) => m.files.map((f) => [f, m.id] as [string, string])));
    moduleMaps.set(r, map);
  }
  return map.get(path);
}

/** 一组符号的入口（每个符号取第一个），一次查询 */
export function entriesOf(ctx: AskToolContext, ids: string[]): Map<string, EntryInfo> {
  const out = new Map<string, EntryInfo>();
  for (const e of ctx.store.getEntriesForSymbols(ctx.snapshot.id, [...new Set(ids)])) {
    if (!out.has(e.symbolId)) out.set(e.symbolId, entryInfo(e));
  }
  return out;
}

export function entryInfo(e: EntryRow): EntryInfo {
  return { kind: e.kind, framework: e.framework, detail: e.detail };
}

/** 入口的简短文字：HTTP 接口为 `HTTP GET /path`，其他为 `<kind> (<framework>)` */
export function entryText(e: EntryInfo): string {
  return isHttpApi(e) ? `HTTP ${httpRoute(e)}`.trim() : `${e.kind} (${e.framework})`;
}

export function location(s: Pick<SymbolRow, 'path' | 'startLine' | 'endLine'>): string {
  return `${s.path}:${s.startLine}-${s.endLine}`;
}

/** 一行符号说明：id、类型、名字、位置，以及接口 / 模型标记和所属模块 */
export function symbolLine(ctx: AskToolContext, s: SymbolRow, entries: Map<string, EntryInfo>, opts: { signature?: boolean } = {}): string {
  const parts = [`${s.id} ${s.kind} ${s.qualifiedName} @ ${location(s)}`];
  if (opts.signature && s.displaySignature) parts.push(`sig: ${s.displaySignature}`);
  const e = entries.get(s.id);
  if (e) parts.push(`entry: ${entryText(e)}`);
  if (s.modelKind) parts.push(`model: ${s.modelKind}`);
  if (s.isTest) parts.push('test');
  const mod = moduleOfPath(ctx, s.path);
  if (mod) parts.push(`module: ${mod}`);
  return parts.join(' | ');
}

export function output(content: string, symbols: SymbolRow[] = [], entries: Map<string, EntryInfo> = new Map()): ToolOutput {
  return { content, symbols, entries };
}
