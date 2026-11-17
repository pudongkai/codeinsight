import { findGoFunc, goLookupPackage, GoSymbolIndex, isGoExternalTest } from '../extract/go-index.js';
import type { ExtractedFile, GoCallSite } from '../extract/types.js';
import type { EdgeRow } from '../model/types.js';

/** 推断出接收者类型或按名字直接找到的调用为 high；没有类型、靠同名方法唯一连上的为 low */
function callConfidence(c: GoCallSite): EdgeRow['confidence'] {
  return c.form === 'selector' && !c.receiverType ? 'low' : 'high';
}

function callEdges(f: ExtractedFile, index: GoSymbolIndex, snapshotId: number): EdgeRow[] {
  const edges: EdgeRow[] = [];
  for (const c of f.go!.calls) {
    const dst = findGoFunc(index, c, goLookupPackage(f));
    if (!dst) continue;
    edges.push({
      snapshotId, srcId: c.callerId, dstId: dst.id, kind: 'call', provenance: 'name_match', confidence: callConfidence(c),
      path: f.path, line: c.line + 1, col: c.col,
    });
  }
  return edges;
}

/** import 路径所在的行（0 起始）：在 import 语句范围内找带引号的路径，找不到时取第一个 import 语句的行 */
function importRow(f: ExtractedFile, lines: readonly string[] | undefined, importPath: string): number {
  const quoted = `"${importPath}"`;
  for (const [a, b] of f.importRows) {
    for (let row = a; row <= b; row++) if (lines?.[row]?.includes(quoted)) return row;
  }
  return f.importRows[0]?.[0] ?? 0;
}

/** 每个 import 了项目内包的文件：本文件 module 符号 → 该包代表文件 module 符号；外部测试包 import 被测包不算导入自己 */
function importEdges(f: ExtractedFile, index: GoSymbolIndex, snapshotId: number, source: string | undefined): EdgeRow[] {
  const lines = source?.split('\n');
  const paths = new Set([...Object.values(f.go!.imports), ...f.go!.dotImports]);
  const edges: EdgeRow[] = [];
  for (const p of paths) {
    const dst = index.representative(p)?.symbols[0];
    if (!dst || (p === f.go!.packagePath && !isGoExternalTest(f.go!, f.path))) continue;
    edges.push({
      snapshotId, srcId: f.symbols[0]!.id, dstId: dst.id, kind: 'import', provenance: 'name_match', confidence: 'high',
      path: f.path, line: importRow(f, lines, p) + 1, col: 0,
    });
  }
  return edges;
}

/**
 * 按名称匹配得到 Go 的调用边和 import 边（不生成 reference 边）。files 要先做过跨文件补全（completeGoFiles），
 * sources 只用来定位 import 边所在的行，缺少时取第一个 import 语句的行
 */
export function goNameMatchEdges(
  files: readonly ExtractedFile[], snapshotId: number, sources?: ReadonlyMap<string, string>, index = new GoSymbolIndex(files),
): EdgeRow[] {
  const edges: EdgeRow[] = [];
  for (const f of files) {
    if (!f.go) continue;
    edges.push(...callEdges(f, index, snapshotId), ...importEdges(f, index, snapshotId, sources?.get(f.path)));
  }
  return edges;
}
