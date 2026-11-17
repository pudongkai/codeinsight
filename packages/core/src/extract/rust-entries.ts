import { joinRoute } from './go-routes.js';
import type { RustSymbolIndex } from './rust-index.js';
import type { ExtractedEntry, ExtractedFile, ExtractedSymbol, RustHandlerRef, RustRoute } from './types.js';

const HANDLER_KINDS = new Set(['function', 'method']);

/** 处理函数对应的符号：带路由属性的函数和闭包直接是符号 id，路径用 resolvePath 查找；找不到或不是函数时为 undefined */
function handlerSymbol(ref: RustHandlerRef, f: ExtractedFile, index: RustSymbolIndex): ExtractedSymbol | undefined {
  if ('symbolId' in ref) return index.symbol(ref.symbolId);
  const r = index.resolvePath(f, ref.segments, ref.mod);
  return r && 'symbol' in r && HANDLER_KINDS.has(r.symbol.kind) ? r.symbol : undefined;
}

/** rocket `.mount(prefix, routes![..])`：处理函数符号 id → 前缀 */
function rocketPrefixes(files: readonly ExtractedFile[], index: RustSymbolIndex): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of files) {
    for (const m of f.rust!.mounts ?? []) {
      for (const h of m.handlers) {
        const sym = handlerSymbol(h, f, index);
        if (sym) out.set(sym.id, [...(out.get(sym.id) ?? []), m.prefix]);
      }
    }
  }
  return out;
}

function routeEntries(r: RustRoute, sym: ExtractedSymbol, prefixes: ReadonlyMap<string, string[]>): ExtractedEntry[] {
  const mounted = r.framework === 'rocket' && 'symbolId' in r.handler ? prefixes.get(sym.id) : undefined;
  return (mounted ?? ['']).map((p) => ({
    symbolId: sym.id, kind: 'http', framework: r.framework, detail: { ...(r.method ? { method: r.method } : {}), path: joinRoute(p, r.path) },
  }));
}

/** 文件里的 clap 子命令名分组：按 crate 目标，以及按包（只算不是 bin 目标的文件，如 lib 里的 cli 模块） */
function clapGroups(files: readonly ExtractedFile[]): { byTarget: Map<string, string[]>; byPackage: Map<string, string[]> } {
  const byTarget = new Map<string, string[]>();
  const byPackage = new Map<string, string[]>();
  for (const f of files) {
    const r = f.rust!;
    const cmds = r.clapCommands ?? [];
    if (cmds.length === 0) continue;
    byTarget.set(r.target, [...(byTarget.get(r.target) ?? []), ...cmds]);
    if (r.targetKind !== 'bin' && r.packageDir !== undefined) byPackage.set(r.packageDir, [...(byPackage.get(r.packageDir) ?? []), ...cmds]);
  }
  return { byTarget, byPackage };
}

/** bin 目标根文件里的 `fn main`；子命令为同一目标里的，加上同一包里非 bin 文件里的 */
function mainEntry(f: ExtractedFile, clap: ReturnType<typeof clapGroups>): ExtractedEntry[] {
  const r = f.rust!;
  if (r.targetKind !== 'bin' || r.target !== f.path) return [];
  const moduleId = f.symbols[0]?.id;
  const main = f.symbols.find((s) => s.kind === 'function' && s.name === 'main' && s.parentId === moduleId);
  if (!main) return [];
  const cmds = [...(clap.byTarget.get(r.target) ?? []), ...(r.packageDir !== undefined ? (clap.byPackage.get(r.packageDir) ?? []) : [])];
  const subcommands = [...new Set(cmds)];
  return [{ symbolId: main.id, kind: 'cli', framework: 'rust', detail: subcommands.length > 0 ? { subcommands } : {} }];
}

/** Rust 入口识别：bin 目标的 main（带 clap 子命令）、提取时收集的路由，处理函数跨文件查找；找不到处理函数的不生成入口 */
export function resolveRustEntries(files: readonly ExtractedFile[], index: RustSymbolIndex): ExtractedEntry[] {
  const rustFiles = files.filter((f) => f.rust);
  const prefixes = rocketPrefixes(rustFiles, index);
  const clap = clapGroups(rustFiles);
  const out: ExtractedEntry[] = [];
  for (const f of rustFiles) {
    out.push(...mainEntry(f, clap));
    for (const r of f.rust!.routes ?? []) {
      const sym = handlerSymbol(r.handler, f, index);
      if (sym) out.push(...routeEntries(r, sym, prefixes));
    }
  }
  return out;
}
