import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GoSymbolIndex } from '../extract/go-index.js';
import { log } from '../log.js';
import type { FallbackReason } from '../model/types.js';
import { decodeScipIndex } from '../scip/reader.js';
import { languageScipPath } from '../store/data-dir.js';
import { findCommand, type FoundCommand } from '../util/command.js';
import { resolverCodeHash, SHARED_SCIP_RESOLVER_MODULES } from './code-hash.js';
import { toolNeedsReresolve } from './edge-sources.js';
import { goNameMatchEdges } from './go-name-match.js';
import { buildGoScipIndex, goModuleDirs, type GoModuleDir } from './go-scip.js';
import { scipToEdges } from './scip-edges.js';
import { goRules, prepareGoIndex } from './scip-rules-go.js';
import { edgeCounts, readSnapshotSources, ToolFallback } from './tool-fallback.js';
import type { EdgeSources, ResolveInput, ResolveResult, Resolver } from './types.js';

/** scip-go 的安装命令（状态栏提示里也写这一条） */
export const SCIP_GO_INSTALL = 'go install github.com/scip-code/scip-go/cmd/scip-go@latest';

/** Go 解析用到的模块：共用的 SCIP 转换加上 Go 专用的部分（名称匹配用的符号查找表也算在内） */
const GO_RESOLVER_MODULES = [
  ...SHARED_SCIP_RESOLVER_MODULES, 'resolve/go', 'resolve/go-scip', 'resolve/go-name-match', 'resolve/scip-rules-go',
  'extract/go-index', 'extract/go-types',
];

/** Go 解析代码的指纹 */
export function goResolverCodeHash(): string {
  return resolverCodeHash('go', GO_RESOLVER_MODULES, []);
}

export interface GoResolverOptions {
  /** 为 false 时不找 scip-go，直接用名称匹配（reason=disabled）；默认 true */
  scip?: boolean;
}

type GoTools =
  | { ok: true; scipGo: string; go: string; version: string }
  | { ok: false; reason: FallbackReason; detail: string };

/** `go install` 的安装目录：~/go/bin 和 GOPATH 各项的 bin */
function goBinDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const gopaths = (env.GOPATH ?? '').split(path.delimiter).filter(Boolean);
  return [path.join(os.homedir(), 'go', 'bin'), ...gopaths.map((p) => path.join(p, 'bin'))];
}

const versions = new Map<string, string>();

/** `scip-go --version` 的输出，按可执行文件路径和修改时间缓存；取不到时为 unknown */
async function scipGoVersion(bin: string): Promise<string> {
  const key = `${bin}\0${statSync(bin, { throwIfNoEntry: false })?.mtimeMs ?? 0}`;
  const hit = versions.get(key);
  if (hit) return hit;
  const version = await new Promise<string>((resolve) => {
    execFile(bin, ['--version'], { timeout: 10_000 }, (err, stdout) => resolve(err ? 'unknown' : stdout.trim().split('\n')[0] || 'unknown'));
  });
  versions.set(key, version);
  return version;
}

function missing(name: string, found: FoundCommand): string | undefined {
  return found.ok ? undefined : `${name}: ${found.detail}`;
}

/** 查找 scip-go 和 go；查找结果来自缓存时不再写日志 */
async function findGoTools(): Promise<GoTools> {
  const scipGo = findCommand('scip-go', { envVar: 'CODEINSIGHT_SCIP_GO', extraDirs: goBinDirs() });
  const go = findCommand('go', { envVar: 'CODEINSIGHT_GO', extraDirs: ['/usr/local/go/bin', ...goBinDirs()] });
  const quiet = scipGo.cached && go.cached;
  if (!scipGo.ok || !go.ok) {
    const detail = [missing('scip-go', scipGo), missing('go', go)].filter(Boolean).join('; ');
    if (!quiet) log.info('scip_go_lookup', { found: false, detail });
    return { ok: false, reason: 'not_found', detail };
  }
  const version = await scipGoVersion(scipGo.path);
  if (!quiet) log.info('scip_go_lookup', { found: true, scipGo: scipGo.path, go: go.path, version });
  return { ok: true, scipGo: scipGo.path, go: go.path, version };
}

/**
 * Go 解析器：找得到 scip-go 和 go 且能加载项目时用 scip-go 的结果；找不到、运行失败或超时时改用名称匹配，
 * 自己不抛异常（被中止时除外）。version 为 `scip-go@<版本>` 或 `name-match` 加上 Go 解析代码的指纹
 */
export class GoResolver implements Resolver {
  readonly name = 'go';
  private tools: GoTools = { ok: false, reason: 'not_found', detail: 'not prepared' };

  constructor(private readonly opts: GoResolverOptions = {}) {}

  async prepare(): Promise<void> {
    this.tools = this.opts.scip === false ? { ok: false, reason: 'disabled', detail: 'scip-go disabled' } : await findGoTools();
  }

  get version(): string {
    return this.versionFor(this.tools.ok ? `scip-go@${this.tools.version}` : 'name-match');
  }

  private versionFor(mode: string): string {
    return `${mode}:${goResolverCodeHash()}`;
  }

  async resolve(input: ResolveInput): Promise<ResolveResult> {
    const sources = await readSnapshotSources(input.root, input.files);
    const index = new GoSymbolIndex(input.files);
    try {
      if (!this.tools.ok) throw new ToolFallback(this.tools.reason, this.tools.detail);
      return await this.resolveWithScip(input, this.tools, sources, index);
    } catch (err) {
      if (input.signal?.aborted) throw err;
      const reason = err instanceof ToolFallback ? err.reason : 'failed';
      const note = (err as Error).message.split('\n')[0]!;
      if (reason === 'failed') log.warn('scip_go_failed', { contentKey: input.contentKey, error: note });
      log.info('go_name_match_fallback', { reason, note });
      const edges = goNameMatchEdges(input.files, input.snapshotId, sources, index);
      log.info('go_edges', { source: 'name_match', ...edgeCounts(edges) });
      return {
        edges,
        sources: { go: { source: 'name_match', reason, at: Date.now(), note } },
        effectiveVersion: this.versionFor('name-match'),
      };
    }
  }

  private async resolveWithScip(
    input: ResolveInput, tools: Extract<GoTools, { ok: true }>, sources: Map<string, string>, symbols: GoSymbolIndex,
  ): Promise<ResolveResult> {
    const modules = await goModuleDirs(input.root, input.files);
    if (modules.length === 0) throw new ToolFallback('no_module', 'no go.mod in snapshot');
    const output = languageScipPath(input.layout, input.contentKey, 'go');
    if (existsSync(output)) log.info('scip_go_cache_hit', { contentKey: input.contentKey });
    else await this.runScip(input, tools, modules, output);
    const raw = decodeScipIndex(await readFile(output));
    const prepared = prepareGoIndex(raw, input.files, symbols, modules.map((m) => m.module));
    const result = scipToEdges(prepared.index, input.files, sources, input.snapshotId, goRules);
    const { definitions, matchedByPosition } = prepared.stats;
    log.info('go_edges', { source: 'scip', documents: prepared.index.documents.length, definitions, matchedByPosition, ...edgeCounts(result.edges) });
    return { ...result, sources: { go: { source: 'scip' } }, effectiveVersion: this.version };
  }

  private async runScip(input: ResolveInput, tools: Extract<GoTools, { ok: true }>, modules: GoModuleDir[], output: string): Promise<void> {
    await buildGoScipIndex({
      root: input.root, modules, bin: tools.scipGo, goBin: tools.go, output,
      timeoutMs: input.goTimeoutMs ?? input.timeoutMs, signal: input.signal,
    });
  }

  /**
   * Go 的边来自名称匹配时：之前找不到工具、现在找到了，或之前运行失败且已过去 FAILED_RERESOLVE_AFTER_MS，
   * 并且现在工具可用时重新解析。没有 go.mod（no_module）时装了工具也用不上，不重新解析
   */
  async needsReresolve(sources: EdgeSources, now = Date.now()): Promise<boolean> {
    return toolNeedsReresolve(sources.go, this.tools.ok, now);
  }
}
