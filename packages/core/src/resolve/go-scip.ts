import { existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BinaryReader, BinaryWriter, WireType } from '@bufbuild/protobuf/wire';
import { goAncestorDirs, goModuleOf, parseGoWorkUses, readGoModules } from '../extract/go-module.js';
import type { ExtractedFile } from '../extract/types.js';
import { log } from '../log.js';
import { runScipGo, ScipRunError } from '../scip/runner.js';

/** 一个要跑 scip-go 的 Go module */
export interface GoModuleDir {
  /** go.mod 所在目录（相对快照根目录），根目录为空字符串 */
  dir: string;
  module: string;
  /** 祖先目录里列出了本 module 的 go.work 所在目录；没有时为 undefined */
  workDir?: string;
  /** 祖先目录里有 go.work 但没有列出本 module：要设 GOWORK=off，否则 go 报 module 不在 go.work 里 */
  workOff?: boolean;
}

/** go.work 的 use 路径规范成相对快照根目录的目录 */
function workUseDirs(workDir: string, text: string): Set<string> {
  const dirs = parseGoWorkUses(text).map((u) => path.posix.normalize(path.posix.join(workDir, u)));
  return new Set(dirs.map((d) => (d === '.' ? '' : d)));
}

/** module 目录向上找最近的 go.work，按它的 use 列表决定用不用它 */
async function workspaceOf(root: string, dir: string): Promise<Pick<GoModuleDir, 'workDir' | 'workOff'>> {
  const workDir = goAncestorDirs(dir).find((d) => existsSync(path.join(root, d, 'go.work')));
  if (workDir === undefined) return {};
  const uses = workUseDirs(workDir, await readFile(path.join(root, workDir, 'go.work'), 'utf8'));
  if (uses.has(dir)) return { workDir };
  log.info('scip_go_module_not_in_work', { dir, workDir });
  return { workOff: true };
}

/**
 * Go 文件所属的 module（每个 go.mod 目录一个，按目录排序）。有 go.work 时仍按 module 分别运行：
 * 在 go.work 目录运行 `./...` 匹配不到包，而在 module 目录运行时 go 会自动使用上层的 go.work
 */
export async function goModuleDirs(root: string, files: readonly ExtractedFile[]): Promise<GoModuleDir[]> {
  const modules = await readGoModules(root, files.map((f) => f.path));
  const dirs = new Set<string>();
  for (const f of files) {
    const mod = goModuleOf(f.path, modules);
    if (mod) dirs.add(mod.dir);
  }
  const out: GoModuleDir[] = [];
  for (const dir of [...dirs].sort()) out.push({ dir, module: modules.get(dir)!, ...(await workspaceOf(root, dir)) });
  return out;
}

/**
 * go 和 scip-go 的环境变量：有 vendor/modules.txt 时用 vendor 目录，否则不许改写 go.mod；module 不在上层 go.work 里时关掉 go.work；不调用 C 编译器、
 * 不下载其他版本的 Go、私有仓库不等待输入；GOPROXY、GOPATH、GOMODCACHE 沿用用户环境。go 所在目录放到 PATH 最前面
 */
export function scipGoEnv(root: string, mod: GoModuleDir, goBin: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const vendorDir = mod.workDir ?? mod.dir;
  const vendored = existsSync(path.join(root, vendorDir, 'vendor', 'modules.txt'));
  return {
    ...base,
    GOFLAGS: vendored ? '-mod=vendor' : '-mod=readonly',
    ...(mod.workOff ? { GOWORK: 'off' } : {}),
    CGO_ENABLED: '0',
    GOTOOLCHAIN: 'local',
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    PATH: [path.dirname(goBin), base.PATH ?? ''].filter(Boolean).join(path.delimiter),
  };
}

/** Document 的 relative_path（字段 1）加上前缀，其他字段原样复制 */
function prefixDocument(bytes: Uint8Array, prefix: string): Uint8Array {
  const r = new BinaryReader(bytes);
  const w = new BinaryWriter();
  while (r.pos < r.len) {
    const [no, wt] = r.tag();
    if (no === 1 && wt === WireType.LengthDelimited) w.tag(1, WireType.LengthDelimited).string(path.posix.join(prefix, r.string()));
    else w.tag(no, wt).raw(r.skip(wt, no));
  }
  return w.finish();
}

/** 把一个 module 的索引里的文档（字段 2）写进合并结果，文档路径加上 module 目录前缀；其他字段丢弃 */
export function appendScipDocuments(out: BinaryWriter, index: Uint8Array, prefix: string): void {
  const r = new BinaryReader(index);
  while (r.pos < r.len) {
    const [no, wt] = r.tag();
    if (no === 2 && wt === WireType.LengthDelimited) {
      const doc = r.bytes();
      out.tag(2, WireType.LengthDelimited).bytes(prefix ? prefixDocument(doc, prefix) : doc);
    } else {
      r.skip(wt, no);
    }
  }
}

export interface ScipGoIndexOptions {
  root: string;
  modules: readonly GoModuleDir[];
  bin: string;
  goBin: string;
  /** 合并后的索引缓存文件 */
  output: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * 对每个 module 运行 scip-go，文档路径加上 module 目录前缀后合并成一个索引写到 output（先写临时文件再改名）。
 * timeoutMs 是全部 module 合计的时间；任一 module 失败时整体失败
 */
export async function buildGoScipIndex(opts: ScipGoIndexOptions): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  const merged = new BinaryWriter();
  const parts: string[] = [];
  try {
    for (const [i, mod] of opts.modules.entries()) {
      const part = opts.output.replace(/\.scip$/, `.${i}.scip`);
      parts.push(part);
      const timeoutMs = deadline - Date.now();
      if (timeoutMs <= 0) throw new ScipRunError(`scip-go timed out after ${opts.timeoutMs}ms`);
      await runScipGo({
        bin: opts.bin, goBin: opts.goBin, moduleDir: path.join(opts.root, mod.dir), output: part,
        env: scipGoEnv(opts.root, mod, opts.goBin), timeoutMs, signal: opts.signal,
      });
      appendScipDocuments(merged, await readFile(part), mod.dir);
    }
    const tmp = `${opts.output}.${process.pid}.tmp`;
    parts.push(tmp);
    await writeFile(tmp, merged.finish());
    await rename(tmp, opts.output);
    log.info('scip_go_indexed', { modules: opts.modules.length });
  } finally {
    await Promise.all(parts.map((p) => rm(p, { force: true })));
  }
}
