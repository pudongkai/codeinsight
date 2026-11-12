import { traverse } from '../graph/traverse.js';
import { symbolIdFromKey } from '../model/symbol-key.js';
import type { SymbolRow } from '../model/types.js';
import { moduleMarkdown } from '../overview/markdown.js';
import { AskToolFailure, optBool, optInt, optString, reqEnum, reqString, type ToolArgs } from './tool-args.js';
import { entriesOf, entryInfo, entryText, location, moduleOfPath, output, symbolLine, type AskToolContext, type ToolOutput } from './tool-context.js';

const MAX_SEARCH = 20;
const MAX_GRAPH_NODES = 50;
const MAX_GRAPH_DEPTH = 3;
const MAX_ENTRIES = 100;
const DOCSTRING_CHARS = 1000;

/** 按 id 找符号；模型给的是 symbol key（含 `#`）时也认 */
export function findSymbol(ctx: AskToolContext, id: string): SymbolRow {
  const snap = ctx.snapshot.id;
  const s = ctx.store.getSymbol(snap, id) ?? (id.includes('#') ? ctx.store.getSymbol(snap, symbolIdFromKey(id)) : undefined);
  if (!s) throw new AskToolFailure('not_found', 'no symbol with this id in the current snapshot; use search_symbols to find ids');
  return s;
}

export function searchSymbols(ctx: AskToolContext, args: ToolArgs): ToolOutput {
  const query = reqString(args, 'query').trim();
  const kind = optString(args, 'kind');
  const limit = optInt(args, 'limit', { min: 1, max: MAX_SEARCH, def: 10 });
  const rows = ctx.store.searchSymbols(ctx.snapshot.id, query, { ...(kind ? { kind } : {}), limit });
  if (rows.length === 0) return output(`No symbols match "${query}".`);
  const entries = entriesOf(ctx, rows.map((s) => s.id));
  return output(rows.map((s) => symbolLine(ctx, s, entries, { signature: true })).join('\n'), rows, entries);
}

/** 直接调用方和被调用方的个数（call + reference 边，按不同符号计，不含自己） */
function neighbourCounts(ctx: AskToolContext, id: string): { callers: number; callees: number } {
  const snap = ctx.snapshot.id;
  const count = (dir: 'in' | 'out') => new Set(ctx.store.getEdgesForSymbols(snap, [id], dir, ['call', 'reference'])
    .map((e) => (dir === 'in' ? e.srcId : e.dstId)).filter((x) => x !== id)).size;
  return { callers: count('in'), callees: count('out') };
}

export function getSymbol(ctx: AskToolContext, args: ToolArgs): ToolOutput {
  const s = findSymbol(ctx, reqString(args, 'id'));
  const entries = entriesOf(ctx, [s.id]);
  const e = entries.get(s.id);
  const n = neighbourCounts(ctx, s.id);
  const mod = moduleOfPath(ctx, s.path);
  const lines = [
    `id: ${s.id}`, `kind: ${s.kind}`, `name: ${s.qualifiedName}`, `location: ${location(s)}`,
    ...(s.displaySignature ? [`signature: ${s.displaySignature}`] : []),
    ...(s.docstring ? [`docstring: ${s.docstring.slice(0, DOCSTRING_CHARS)}`] : []),
    ...(e ? [`entry: ${entryText(e)}`] : []),
    ...(s.modelKind ? [`model: ${s.modelKind}`] : []),
    ...(mod ? [`module: ${mod}`] : []),
    `callers: ${n.callers}, callees: ${n.callees}`,
    ...(s.isTest ? ['test code'] : []),
  ];
  return output(lines.join('\n'), [s], entries);
}

export function getCallGraph(ctx: AskToolContext, args: ToolArgs): ToolOutput {
  const id = reqString(args, 'id');
  const direction = reqEnum(args, 'direction', ['callers', 'callees'] as const);
  const depth = optInt(args, 'depth', { min: 1, max: MAX_GRAPH_DEPTH, def: 1 });
  const includeTests = optBool(args, 'includeTests', false);
  const origin = findSymbol(ctx, id);
  const r = traverse(ctx.store, ctx.snapshot.id, [origin.id], { direction, depth, includeTests });
  const reached = [...(r.reached.get(origin.id) ?? new Map<string, number>())]
    .map(([id, d]) => ({ s: r.symbols.get(id)!, d }))
    .sort((a, b) => a.d - b.d || a.s.path.localeCompare(b.s.path) || a.s.startLine - b.s.startLine);
  const shown = reached.slice(0, MAX_GRAPH_NODES);
  const entries = entriesOf(ctx, [origin.id, ...shown.map((x) => x.s.id)]);
  const lines = [`${direction} of ${symbolLine(ctx, origin, entries)}`];
  if (shown.length === 0) lines.push(`(no ${direction})`);
  for (let d = 1; d <= depth; d++) {
    const layer = shown.filter((x) => x.d === d);
    if (layer.length > 0) lines.push(`depth ${d}:`, ...layer.map((x) => `  ${symbolLine(ctx, x.s, entries)}`));
  }
  if (reached.length > shown.length) lines.push(`(${reached.length - shown.length} more not shown)`);
  return output(lines.join('\n'), [origin, ...shown.map((x) => x.s)], entries);
}

export function listEntries(ctx: AskToolContext, args: ToolArgs): ToolOutput {
  const kind = optString(args, 'kind');
  const pathContains = optString(args, 'pathContains');
  const snap = ctx.snapshot.id;
  const rows = ctx.store.getEntries(snap).filter((e) => !kind || e.kind === kind);
  const symbols = new Map(ctx.store.getSymbolsByIds(snap, [...new Set(rows.map((e) => e.symbolId))]).map((s) => [s.id, s]));
  const items = rows
    .map((e) => ({ e, s: symbols.get(e.symbolId) }))
    .filter((x): x is { e: typeof x.e; s: SymbolRow } => x.s !== undefined && (!pathContains || x.s.path.includes(pathContains)))
    .sort((a, b) => a.s.path.localeCompare(b.s.path) || a.s.startLine - b.s.startLine);
  if (items.length === 0) return output('No entries match.');
  const shown = items.slice(0, MAX_ENTRIES);
  const entries = new Map(shown.map((x) => [x.s.id, entryInfo(x.e)]));
  const lines = shown.map((x) => `${entryText(entries.get(x.s.id)!)} -> ${x.s.id} ${x.s.qualifiedName} @ ${location(x.s)}`);
  if (items.length > shown.length) lines.push(`(${items.length - shown.length} more not shown; narrow with kind or pathContains)`);
  return output(lines.join('\n'), shown.map((x) => x.s), entries);
}

export function getModule(ctx: AskToolContext, args: ToolArgs): ToolOutput {
  const r = ctx.overview;
  if (!r) throw new AskToolFailure('overview_missing', 'no system overview has been generated; run `codeinsight overview` first');
  const name = optString(args, 'module');
  if (!name) {
    return output(['Modules (id | name | responsibility):', ...r.modules.map((m) => `${m.id} | ${m.name} | ${m.responsibility ?? ''}`)].join('\n'));
  }
  const md = moduleMarkdown(r, name);
  if (!md) throw new AskToolFailure('not_found', 'no module with this id or name; call get_module without arguments to list modules');
  return output(md);
}
