import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { dirOf, goAncestorDirs } from '../extract/go-module.js';
import { collectRustCrates, type RustPackage } from '../extract/rust-cargo.js';
import { RustSymbolIndex } from '../extract/rust-index.js';
import { log } from '../log.js';
import type { EdgeSource, FallbackReason } from '../model/types.js';
import { decodeScipIndex } from '../scip/reader.js';
import { languageScipPath } from '../store/data-dir.js';
import { resolverCodeHash, SHARED_SCIP_RESOLVER_MODULES } from './code-hash.js';
import { toolNeedsReresolve } from './edge-sources.js';
import { rustNameMatchEdges } from './rust-name-match.js';
import { buildRustScipIndex, readRustScipCache, rustFileRoots, rustRunRoots, type RustScipResult } from './rust-scip.js';
import { readRegularFile } from '../util/regular-file.js';
import { findRustTools, RUST_ANALYZER_INSTALL, type RustTools, type RustToolsLookup } from './rust-tools.js';
import { scipToEdges } from './scip-edges.js';
import { prepareRustIndex, rustRules } from './scip-rules-rust.js';
import { edgeCounts, readSnapshotSources, ToolFallback } from './tool-fallback.js';
import type { EdgeSources, ResolveInput, ResolveResult, Resolver } from './types.js';

export { RUST_ANALYZER_INSTALL };

/** Rust 解析用到的模块：共用的 SCIP 转换加上 Rust 专用的部分（名称匹配用的符号查找表也算在内） */
export const RUST_RESOLVER_MODULES = [
  ...SHARED_SCIP_RESOLVER_MODULES, 'resolve/rust', 'resolve/rust-tools', 'resolve/rust-scip', 'resolve/rust-run-dir',
  'resolve/scip-rules-rust', 'resolve/rust-name-match', 'extract/rust-index', 'extract/rust-facts', 'extract/rust-cargo',
];

/** Rust 解析代码的指纹 */
export function rustResolverCodeHash(): string {
  return resolverCodeHash('rust', RUST_RESOLVER_MODULES, []);
}

export interface RustResolverOptions {
  /** 为 false 时不找 rust-analyzer，直接用名称匹配（reason=disabled）；默认 true */
  scip?: boolean;
}

const CARGO_INPUTS = ['Cargo.toml', 'rust-toolchain', 'rust-toolchain.toml'];

/** 读快照里的 Cargo 输入文件：只读普通文件（符号链接可能指向仓库外的文件） */
async function readCargoInput(root: string, rel: string): Promise<string> {
  const text = await readRegularFile(path.join(root, rel));
  if (text === undefined) throw new Error('not a regular file');
  return text;
}

/** 从各 Rust 文件所在目录往上到快照根目录，找出存在的 Cargo.toml 和 rust-toolchain 文件后解析 */
async function snapshotPackages(root: string, files: ResolveInput['files']): Promise<Map<string, RustPackage>> {
  const dirs = new Set(files.flatMap((f) => goAncestorDirs(dirOf(f.path))));
  const paths = [...dirs].flatMap((d) => CARGO_INPUTS.map((n) => (d === '' ? n : `${d}/${n}`))).filter((p) => existsSync(path.join(root, p)));
  return collectRustCrates(paths, (p) => readCargoInput(root, p), (p, err) => log.warn('rust_cargo_toml_skipped', { path: p, reason: firstLine(err) }));
}

/** 错误说明的第一行：TOML 解析错误后面几行带着出错的源码，不写进日志 */
function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0]!;
}

/** 失败的根目录的说明：`<目录>: <第一行原因>`，多个用 `; ` 连接 */
function failedRootsNote(result: RustScipResult): string {
  return result.roots.filter((r) => !r.ok).map((r) => `${r.dir || '.'}: ${r.error ?? 'failed'}`).join('; ');
}

interface RustInput {
  input: ResolveInput;
  sources: Map<string, string>;
  index: RustSymbolIndex;
}

/**
 * Rust 解析器：找得到 rust-analyzer 和 cargo 时，各运行根目录用 rust-analyzer scip 的结果，失败的根目录和不在任何
 * 运行根目录下的文件用名称匹配补边；找不到工具或全部失败时整体用名称匹配。自己不抛异常（被中止时除外）。
 * version 为 `rust-analyzer@<版本>` 或 `name-match` 加上 Rust 解析代码的指纹
 */
export class RustResolver implements Resolver {
  readonly name = 'rust';
  private tools: RustToolsLookup = { ok: false, reason: 'not_found', detail: 'not prepared' };

  constructor(private readonly opts: RustResolverOptions = {}) {}

  async prepare(): Promise<void> {
    this.tools = this.opts.scip === false ? { ok: false, reason: 'disabled', detail: 'rust-analyzer disabled' } : await findRustTools();
  }

  get version(): string {
    return this.versionFor(this.tools.ok ? `rust-analyzer@${this.tools.tools.version}` : 'name-match');
  }

  private versionFor(mode: string): string {
    return `${mode}:${rustResolverCodeHash()}`;
  }

  async resolve(input: ResolveInput): Promise<ResolveResult> {
    const ctx: RustInput = { input, sources: await readSnapshotSources(input.root, input.files), index: new RustSymbolIndex(input.files) };
    try {
      if (!this.tools.ok) throw new ToolFallback(this.tools.reason, this.toolsNote(this.tools.reason, this.tools.detail));
      return await this.resolveWithScip(ctx, this.tools.tools);
    } catch (err) {
      if (input.signal?.aborted) throw err;
      const reason = err instanceof ToolFallback ? err.reason : 'failed';
      const note = (err as Error).message.split('\n')[0]!;
      if (reason === 'failed') log.warn('scip_rust_failed', { contentKey: input.contentKey, error: note });
      log.info('rust_name_match_fallback', { reason, note });
      const edges = await rustNameMatchEdges(input.files, input.snapshotId, ctx.sources, ctx.index);
      log.info('rust_edges', { source: 'name_match', ...edgeCounts(edges) });
      const at = err instanceof ToolFallback && err.at !== undefined ? err.at : Date.now();
      return { edges, sources: { rust: { source: 'name_match', reason, at, note } }, effectiveVersion: this.versionFor('name-match') };
    }
  }

  private toolsNote(reason: FallbackReason, detail: string): string {
    return reason === 'not_found' && !detail.includes('install:') ? `${detail} (install: ${RUST_ANALYZER_INSTALL})` : detail;
  }

  private async resolveWithScip(ctx: RustInput, tools: RustTools): Promise<ResolveResult> {
    const { input } = ctx;
    const packages = await snapshotPackages(input.root, input.files);
    if (packages.size === 0) throw new ToolFallback('no_module', 'no Cargo.toml in snapshot');
    if (rustRunRoots(packages).length === 0) {
      throw new ToolFallback('no_module', 'no cargo root to index (packages are only under tests/, examples/, fixtures/ or testdata/)');
    }
    const { result, index } = await this.scipIndex(input, packages, tools);
    const okRoots = new Set(result.roots.filter((r) => r.ok).map((r) => r.dir));
    if (okRoots.size === 0) throw new ToolFallback('failed', failedRootsNote(result), result.at);
    const fileRoots = rustFileRoots(input.files, packages, rustRunRoots(packages));
    const scipFiles = input.files.filter((f) => okRoots.has(fileRoots.get(f.path) ?? '\0'));
    const restFiles = input.files.filter((f) => !okRoots.has(fileRoots.get(f.path) ?? '\0'));
    const prepared = prepareRustIndex(decodeScipIndex(index), scipFiles, ctx.sources, packages);
    const scip = scipToEdges(prepared.index, scipFiles, ctx.sources, input.snapshotId, rustRules);
    const fallback = restFiles.length > 0 ? await rustNameMatchEdges(restFiles, input.snapshotId, ctx.sources, ctx.index) : [];
    log.info('rust_edges', {
      source: 'scip', ...prepared.stats, scipFiles: scipFiles.length, nameMatchFiles: restFiles.length,
      ...edgeCounts(scip.edges), nameMatchEdges: fallback.length,
    });
    const source = this.edgeSource(result);
    const effectiveVersion = source.source === 'scip' ? this.version : this.versionFor('name-match');
    return { edges: [...scip.edges, ...fallback], note: scip.note, sources: { rust: source }, effectiveVersion };
  }

  /** 全部根目录成功为 scip；有失败的根目录时为 name_match/failed，note 列出失败的根目录 */
  private edgeSource(result: RustScipResult): EdgeSource {
    const warnings = result.warnings.length > 0 ? { warnings: result.warnings } : {};
    const failed = failedRootsNote(result);
    if (!failed) return { source: 'scip', ...warnings };
    return { source: 'name_match', reason: 'failed', at: result.at, note: failed, ...warnings };
  }

  private async scipIndex(
    input: ResolveInput, packages: Map<string, RustPackage>, tools: RustTools,
  ): Promise<{ result: RustScipResult; index: Uint8Array }> {
    const output = languageScipPath(input.layout, input.contentKey, 'rust');
    const cached = await readRustScipCache(output);
    if (cached) {
      log.info('scip_rust_cache_hit', { contentKey: input.contentKey });
      return cached;
    }
    const result = await buildRustScipIndex({
      snapshotDir: input.root, contentKey: input.contentKey, files: input.files, packages, tools, output,
      timeoutMs: input.rustTimeoutMs ?? input.timeoutMs, signal: input.signal,
    });
    const index = existsSync(output) ? await readFile(output) : new Uint8Array();
    return { result, index };
  }

  /**
   * Rust 的边来自名称匹配时：之前找不到工具、现在找到了，或之前运行失败且已过去 FAILED_RERESOLVE_AFTER_MS，
   * 并且现在工具可用时重新解析。没有 Cargo.toml（no_module）时装了工具也用不上，不重新解析
   */
  async needsReresolve(sources: EdgeSources, now = Date.now()): Promise<boolean> {
    return toolNeedsReresolve(sources.rust, this.tools.ok, now);
  }
}
