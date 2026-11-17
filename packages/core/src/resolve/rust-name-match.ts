import { getRustParser } from '../extract/parser.js';
import { expandRustUses } from '../extract/rust-facts.js';
import { RustSymbolIndex, type ResolvedPath } from '../extract/rust-index.js';
import type { ExtractedFile, ExtractedSymbol, RustCallSite } from '../extract/types.js';
import type { EdgeRow } from '../model/types.js';

const CALLABLE_KINDS = new Set(['function', 'method']);

function resolvedSymbol(r: ResolvedPath | undefined): { symbol: ExtractedSymbol; file: ExtractedFile } | undefined {
  return r && 'symbol' in r ? r : undefined;
}

/** method 形式调用的目标：有接收者类型时按（类型，方法名）找为 high；没有时同名方法在项目里唯一才连，为 low */
function methodTarget(c: RustCallSite, index: RustSymbolIndex): { dst: ExtractedSymbol; confidence: EdgeRow['confidence'] } | undefined {
  const name = c.segments[c.segments.length - 1]!;
  if (c.receiverType) {
    const m = index.method(c.receiverType, name);
    return m ? { dst: m, confidence: 'high' } : undefined;
  }
  const all = index.methodsNamed(name);
  return all.length === 1 ? { dst: all[0]!, confidence: 'low' } : undefined;
}

/** path 形式调用的目标：路径解析到项目里的函数或方法为 high；类型、模块、外部 crate 不出边 */
function pathTarget(f: ExtractedFile, c: RustCallSite, index: RustSymbolIndex): { dst: ExtractedSymbol; confidence: EdgeRow['confidence'] } | undefined {
  const r = resolvedSymbol(index.resolvePath(f, c.segments, c.mod));
  return r && CALLABLE_KINDS.has(r.symbol.kind) ? { dst: r.symbol, confidence: 'high' } : undefined;
}

function callEdges(f: ExtractedFile, index: RustSymbolIndex, snapshotId: number): EdgeRow[] {
  const edges: EdgeRow[] = [];
  for (const c of f.rust!.calls) {
    const target = c.form === 'method' ? methodTarget(c, index) : pathTarget(f, c, index);
    if (!target) continue;
    edges.push({
      snapshotId, srcId: c.callerId, dstId: target.dst.id, kind: 'call', provenance: 'name_match', confidence: target.confidence,
      path: f.path, line: c.line + 1, col: c.col,
    });
  }
  return edges;
}

/**
 * 每个 use 叶子一条 import 边：叶子解析到项目里其他文件的项（`use x::*` 为模块 x）时，
 * 本文件 module 符号 → 该项所在文件 module 符号；位置为叶子所在位置，与 SCIP 路径一致
 */
async function importEdges(f: ExtractedFile, index: RustSymbolIndex, snapshotId: number, source: string): Promise<EdgeRow[]> {
  const tree = (await getRustParser()).parse(source);
  if (!tree) return [];
  try {
    const edges: EdgeRow[] = [];
    for (const u of expandRustUses(tree.rootNode)) {
      if (u.name === '_' && !u.glob) continue;
      const dstFile = resolvedSymbol(index.resolvePath(f, u.path, u.mod))?.file;
      const dst = dstFile?.symbols[0];
      if (!dst || dstFile === f) continue;
      edges.push({
        snapshotId, srcId: f.symbols[0]!.id, dstId: dst.id, kind: 'import', provenance: 'name_match', confidence: 'high',
        path: f.path, line: u.leaf.line + 1, col: u.leaf.col,
      });
    }
    return edges;
  } finally {
    tree.delete();
  }
}

/**
 * 按名称匹配得到 Rust 的调用边和 import 边（不生成 reference 边）。files 要先做过跨文件补全（completeRustFiles），
 * sources 用来重新展开 use 声明；缺少源码的文件不生成 import 边
 */
export async function rustNameMatchEdges(
  files: readonly ExtractedFile[], snapshotId: number, sources: ReadonlyMap<string, string>, index = new RustSymbolIndex(files),
): Promise<EdgeRow[]> {
  const edges: EdgeRow[] = [];
  for (const f of files) {
    if (!f.rust || !f.symbols[0]) continue;
    edges.push(...callEdges(f, index, snapshotId));
    const source = sources.get(f.path);
    if (source !== undefined) edges.push(...(await importEdges(f, index, snapshotId, source)));
  }
  return edges;
}
