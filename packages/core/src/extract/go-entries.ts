import { findGoFunc, goLookupPackage, type GoSymbolIndex } from './go-index.js';
import type { ExtractedEntry, ExtractedFile, ExtractedSymbol, GoHandlerRef } from './types.js';

/** 处理函数对应的符号：函数字面量直接是符号 id，按名字引用的按名称匹配规则查找 */
function handlerSymbol(ref: GoHandlerRef, f: ExtractedFile, index: GoSymbolIndex): ExtractedSymbol | undefined {
  if ('symbolId' in ref) return f.symbols.find((s) => s.id === ref.symbolId);
  return findGoFunc(index, ref, goLookupPackage(f));
}

/** `package main` 里的 `func main()` */
function mainEntries(f: ExtractedFile): ExtractedEntry[] {
  if (f.go!.packageName !== 'main') return [];
  const main = f.symbols.find((s) => s.kind === 'function' && s.qualifiedName === `${f.go!.packagePath}.main`);
  return main ? [{ symbolId: main.id, kind: 'cli', framework: 'go', detail: {} }] : [];
}

/** 一个文件的路由和 cobra 命令；找不到处理函数的不生成入口 */
function fileEntries(f: ExtractedFile, index: GoSymbolIndex): ExtractedEntry[] {
  const out = mainEntries(f);
  for (const r of f.go!.routes ?? []) {
    const sym = handlerSymbol(r.handler, f, index);
    const detail = { ...(r.method ? { method: r.method } : {}), path: r.path };
    if (sym) out.push({ symbolId: sym.id, kind: 'http', framework: r.framework, detail });
  }
  for (const c of f.go!.cobraCommands ?? []) {
    const sym = handlerSymbol(c.handler, f, index);
    if (sym) out.push({ symbolId: sym.id, kind: 'cli', framework: 'cobra', detail: { use: c.use } });
  }
  return out;
}

/** Go 入口识别：main 函数、提取时收集的路由和 cobra 命令，处理函数跨文件查找 */
export function resolveGoEntries(files: readonly ExtractedFile[], index: GoSymbolIndex): ExtractedEntry[] {
  return files.filter((f) => f.go).flatMap((f) => fileEntries(f, index));
}
