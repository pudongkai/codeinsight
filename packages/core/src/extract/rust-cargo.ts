import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { inRustExcludedDir, rustExcludedDirs } from '../model/language.js';
import { dirOf } from './go-module.js';

export type RustTargetKind = 'lib' | 'bin' | 'test' | 'bench' | 'example' | 'build';

/** 一个 crate 目标；root 为根文件路径（相对仓库根目录） */
export interface RustTarget {
  kind: RustTargetKind;
  name: string;
  root: string;
}

/** 仓库里的一个 cargo 包 */
export interface RustPackage {
  /** Cargo.toml 所在目录（相对仓库根目录），根目录为空字符串 */
  dir: string;
  name: string;
  /** lib 目标的 crate 名；没有 lib 目标时为空 */
  libName?: string;
  targets: RustTarget[];
  /** 各依赖表的键（改名的依赖取键名） */
  deps: string[];
  /** 所属工作区的根目录；不属于任何工作区时为空 */
  workspaceRoot?: string;
  /** 最近的 rust-toolchain(.toml) 里的 channel */
  toolchainChannel?: string;
}

/** 文件所属的 crate 目标和模块路径 */
export interface RustFileUnit {
  /** crate 名（`-` 换成 `_`） */
  crate: string;
  /** 目标根文件路径；`tests/<dir>` 这类虚拟目标为目录路径，不在任何目标里的文件为文件本身 */
  target: string;
  /** 目标的种类；不在任何目标里的文件没有 */
  kind?: RustTargetKind;
  modulePath: string[];
  /** 所在包的目录；不在任何包里时为空 */
  packageDir?: string;
}

type Table = Record<string, unknown>;

const TOOLCHAIN_FILES = new Set(['rust-toolchain', 'rust-toolchain.toml']);
const CHANNEL_RE = /^[A-Za-z0-9._-]+$/;

function isTable(v: unknown): v is Table {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function joinRel(dir: string, rel: string): string {
  const joined = path.posix.normalize(dir ? `${dir}/${rel}` : rel);
  return joined.startsWith('./') ? joined.slice(2) : joined;
}

/** 相对 dir 的路径；不在 dir 下时为 undefined */
function relativeTo(dir: string, filePath: string): string | undefined {
  if (dir === '') return filePath;
  return filePath.startsWith(`${dir}/`) ? filePath.slice(dir.length + 1) : undefined;
}

export function rustCrateName(name: string): string {
  return name.replace(/-/g, '_');
}

/** rust-toolchain.toml 的 `[toolchain] channel`，旧格式 rust-toolchain 的整个文件；不合法时为 undefined */
export function parseToolchainChannel(fileName: string, text: string): string | undefined {
  let channel: unknown;
  try {
    const doc = parseToml(text);
    channel = isTable(doc.toolchain) ? doc.toolchain.channel : undefined;
  } catch {
    channel = path.posix.basename(fileName) === 'rust-toolchain' ? text.trim() : undefined;
  }
  return typeof channel === 'string' && CHANNEL_RE.test(channel) ? channel : undefined;
}

// ---- 依赖 ----

const DEP_TABLES = ['dependencies', 'dev-dependencies', 'build-dependencies', 'dev_dependencies', 'build_dependencies'];

function depKeys(t: Table): string[] {
  return DEP_TABLES.flatMap((k) => (isTable(t[k]) ? Object.keys(t[k]) : []));
}

/** `[dependencies]` 等各依赖表和 `[target.*.dependencies]` 的键 */
export function cargoDeps(doc: Table): string[] {
  const out = new Set(depKeys(doc));
  if (isTable(doc.target)) for (const t of Object.values(doc.target)) if (isTable(t)) for (const k of depKeys(t)) out.add(k);
  return [...out].sort();
}

// ---- 目标 ----

/** 一个目标表（`[lib]`、`[[bin]]` 等）的 name 和 path */
function targetEntries(v: unknown): { name?: string; path?: string }[] {
  const list = Array.isArray(v) ? v : isTable(v) ? [v] : [];
  return list.filter(isTable).map((t) => ({
    name: typeof t.name === 'string' ? t.name : undefined,
    path: typeof t.path === 'string' ? t.path : undefined,
  }));
}

/** 目录下按默认布局自动发现的目标文件：`<sub>/*.rs` 和 `<sub>/*\/main.rs`，名字为文件名或目录名 */
function discovered(files: ReadonlySet<string>, pkgDir: string, sub: string): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  for (const f of files) {
    const rel = relativeTo(pkgDir, f);
    const m = rel === undefined ? null : new RegExp(`^${sub}/([^/]+)(\\.rs|/main\\.rs)$`).exec(rel);
    if (m) out.push({ name: m[1]!, path: rel! });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

interface TargetInput {
  doc: Table;
  pkg: Table;
  dir: string;
  name: string;
  files: ReadonlySet<string>;
}

function has(input: TargetInput, rel: string): boolean {
  return input.files.has(joinRel(input.dir, rel));
}

function libTarget(input: TargetInput): RustTarget | undefined {
  const lib = targetEntries(input.doc.lib)[0];
  const rel = lib?.path ?? (has(input, 'src/lib.rs') ? 'src/lib.rs' : undefined);
  if (!rel) return undefined;
  return { kind: 'lib', name: rustCrateName(lib?.name ?? input.name), root: joinRel(input.dir, rel) };
}

/** 显式写的目标优先，自动发现的同名目标被覆盖；auto 为 false 时不自动发现 */
function mergeTargets(kind: RustTargetKind, explicit: { name?: string; path?: string }[], auto: { name: string; path: string }[], dir: string, defaultPath: (name: string) => string | undefined): RustTarget[] {
  const byName = new Map<string, RustTarget>();
  for (const a of auto) byName.set(a.name, { kind, name: a.name, root: joinRel(dir, a.path) });
  for (const e of explicit) {
    const rel = e.path ?? (e.name ? defaultPath(e.name) : undefined);
    if (!rel) continue;
    const name = e.name ?? path.posix.basename(rel, '.rs');
    byName.set(name, { kind, name, root: joinRel(dir, rel) });
  }
  return [...byName.values()];
}

function binTargets(input: TargetInput): RustTarget[] {
  const auto = input.pkg.autobins !== false
    ? [...(has(input, 'src/main.rs') ? [{ name: input.name, path: 'src/main.rs' }] : []), ...discovered(input.files, input.dir, 'src/bin')]
    : [];
  const defaultPath = (name: string): string | undefined => {
    if (name === input.name && has(input, 'src/main.rs')) return 'src/main.rs';
    return [`src/bin/${name}.rs`, `src/bin/${name}/main.rs`].find((p) => has(input, p));
  };
  return mergeTargets('bin', targetEntries(input.doc.bin), auto, input.dir, defaultPath);
}

/** tests、benches、examples 目录下的目标 */
function dirTargets(input: TargetInput, kind: RustTargetKind, table: string, sub: string, autoKey: string): RustTarget[] {
  const auto = input.pkg[autoKey] === false ? [] : discovered(input.files, input.dir, sub);
  const defaultPath = (name: string): string | undefined => [`${sub}/${name}.rs`, `${sub}/${name}/main.rs`].find((p) => has(input, p));
  return mergeTargets(kind, targetEntries(input.doc[table]), auto, input.dir, defaultPath);
}

function buildTarget(input: TargetInput): RustTarget | undefined {
  const build = input.pkg.build;
  if (build === false) return undefined;
  const rel = typeof build === 'string' ? build : has(input, 'build.rs') ? 'build.rs' : undefined;
  return rel ? { kind: 'build', name: 'build_script_build', root: joinRel(input.dir, rel) } : undefined;
}

/** 包的全部 crate 目标：默认布局加上 Cargo.toml 里显式写的目标 */
export function cargoTargets(input: TargetInput): RustTarget[] {
  const lib = libTarget(input);
  const build = buildTarget(input);
  return [
    ...(lib ? [lib] : []),
    ...binTargets(input),
    ...dirTargets(input, 'test', 'test', 'tests', 'autotests'),
    ...dirTargets(input, 'bench', 'bench', 'benches', 'autobenches'),
    ...dirTargets(input, 'example', 'example', 'examples', 'autoexamples'),
    ...(build ? [build] : []),
  ];
}

// ---- 工作区和包 ----

interface Workspace {
  dir: string;
  members: string[];
  exclude: string[];
}

interface ParsedManifest {
  dir: string;
  doc: Table;
}

/** members、exclude 里的目录写法规范化：去掉 `./` 和结尾的 `/` */
function normalizedDir(pattern: string): string {
  return path.posix.normalize(pattern).replace(/^\.\//, '').replace(/\/$/, '');
}

/** 包目录是不是工作区的成员：members（支持通配）里有、exclude 里没有；工作区根目录自己的包也是成员 */
function isMember(ws: Workspace, pkgDir: string): boolean {
  const rel = pkgDir === ws.dir ? '' : relativeTo(ws.dir, pkgDir);
  if (rel === undefined) return false;
  if (rel === '') return true;
  const matches = (pattern: string): boolean => {
    const p = normalizedDir(pattern);
    return rel === p || path.posix.matchesGlob(rel, p);
  };
  const excluded = (pattern: string): boolean => {
    const e = normalizedDir(pattern);
    return rel === e || rel.startsWith(`${e}/`);
  };
  return ws.members.some(matches) && !ws.exclude.some(excluded);
}

/** 离包目录最近、把它列为成员的工作区 */
function workspaceOf(workspaces: Workspace[], pkgDir: string): string | undefined {
  let best: Workspace | undefined;
  for (const ws of workspaces) if (isMember(ws, pkgDir) && (!best || ws.dir.length > best.dir.length)) best = ws;
  return best?.dir;
}

/** 离 dir 最近的 rust-toolchain(.toml) 的 channel */
function nearestChannel(dir: string, channels: ReadonlyMap<string, string>): string | undefined {
  for (let d: string | undefined = dir; d !== undefined; d = d === '' ? undefined : dirOf(d)) {
    const hit = channels.get(d);
    if (hit) return hit;
  }
  return undefined;
}

function packageOf(m: ParsedManifest, files: ReadonlySet<string>, workspaces: Workspace[], channels: ReadonlyMap<string, string>): RustPackage | undefined {
  const pkg = m.doc.package;
  if (!isTable(pkg) || typeof pkg.name !== 'string') return undefined;
  const targets = cargoTargets({ doc: m.doc, pkg, dir: m.dir, name: pkg.name, files });
  const lib = targets.find((t) => t.kind === 'lib');
  const workspaceRoot = workspaceOf(workspaces, m.dir);
  const toolchainChannel = nearestChannel(m.dir, channels);
  return {
    dir: m.dir, name: pkg.name, ...(lib ? { libName: lib.name } : {}), targets, deps: cargoDeps(m.doc),
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}), ...(toolchainChannel ? { toolchainChannel } : {}),
  };
}

export interface CargoInputs {
  /** Cargo.toml 路径 → 内容 */
  manifests: ReadonlyMap<string, string>;
  /** rust-toolchain(.toml) 路径 → 内容 */
  toolchains?: ReadonlyMap<string, string>;
  /** 完整文件清单，按默认布局找目标文件 */
  files: Iterable<string>;
  onParseError?: (filePath: string, err: unknown) => void;
}

/** TOML 解析错误的说明和位置；smol-toml 的完整错误信息带着出错的源码行，不往外传 */
function tomlErrorSummary(err: unknown): Error {
  const e = err as Error & { line?: unknown; column?: unknown };
  const first = (e.message ?? '').split('\n')[0] ?? 'invalid TOML';
  const at = typeof e.line === 'number' ? ` (line ${e.line}, column ${String(e.column)})` : '';
  return new Error(`${first}${at}`);
}

function parseManifests(inputs: CargoInputs): ParsedManifest[] {
  const out: ParsedManifest[] = [];
  for (const [p, text] of inputs.manifests) {
    try {
      out.push({ dir: dirOf(p), doc: parseToml(text) as Table });
    } catch (err) {
      inputs.onParseError?.(p, tomlErrorSummary(err));
    }
  }
  return out;
}

/** 目录 → channel；同一目录两种文件都有时和 rustup 一样以旧格式 rust-toolchain 为准 */
function toolchainChannels(toolchains: ReadonlyMap<string, string> | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const entries = [...(toolchains ?? [])].sort(([a], [b]) => (b.endsWith('.toml') ? 1 : 0) - (a.endsWith('.toml') ? 1 : 0));
  for (const [p, text] of entries) {
    const channel = parseToolchainChannel(p, text);
    if (channel) out.set(dirOf(p), channel);
  }
  return out;
}

/** 解析一组 Cargo.toml，得到 `包目录 → 包信息`；解析失败的交给 onParseError 并跳过 */
export function rustCratesFromManifests(inputs: CargoInputs): Map<string, RustPackage> {
  const files = new Set(inputs.files);
  const manifests = parseManifests(inputs);
  const workspaces: Workspace[] = manifests.filter((m) => isTable(m.doc.workspace)).map((m) => {
    const ws = m.doc.workspace as Table;
    return { dir: m.dir, members: stringArray(ws.members), exclude: stringArray(ws.exclude) };
  });
  const channels = toolchainChannels(inputs.toolchains);
  const out = new Map<string, RustPackage>();
  for (const m of manifests) {
    const pkg = packageOf(m, files, workspaces, channels);
    if (pkg) out.set(pkg.dir, pkg);
  }
  return out;
}

/** 要读的 Cargo 配置文件：Cargo.toml、rust-toolchain(.toml)，排除目录下的除外 */
export function isCargoInput(filePath: string, excluded: ReadonlySet<string>): boolean {
  const base = path.posix.basename(filePath);
  return (base === 'Cargo.toml' || TOOLCHAIN_FILES.has(base)) && !inRustExcludedDir(filePath, excluded);
}

/**
 * 从 paths 里挑出 Cargo.toml 和 rust-toolchain(.toml) 逐个读取后解析；
 * 读取或解析失败的交给 onError（没给时直接跳过）
 */
export async function collectRustCrates(
  paths: Iterable<string>, read: (filePath: string) => Promise<string>, onError?: (filePath: string, err: unknown) => void,
): Promise<Map<string, RustPackage>> {
  const all = [...paths];
  const excluded = rustExcludedDirs(all);
  const manifests = new Map<string, string>();
  const toolchains = new Map<string, string>();
  for (const p of all) {
    if (!isCargoInput(p, excluded)) continue;
    let text: string;
    try {
      text = await read(p);
    } catch (err) {
      onError?.(p, err);
      continue;
    }
    (path.posix.basename(p) === 'Cargo.toml' ? manifests : toolchains).set(p, text);
  }
  return rustCratesFromManifests({ manifests, toolchains, files: all, onParseError: onError });
}

/** 包所在的 cargo 根目录：工作区根目录，不属于工作区时为包目录 */
export function cargoRootDir(pkg: RustPackage): string {
  return pkg.workspaceRoot ?? pkg.dir;
}

/** 放 Cargo.lock 的目录：各工作区根目录，以及不属于任何工作区的包目录 */
export function cargoLockDirs(crates: ReadonlyMap<string, RustPackage>): string[] {
  return [...new Set([...crates.values()].map(cargoRootDir))].sort();
}

// ---- 文件 → 目标和模块路径 ----

/** 离文件最近的包 */
function packageForFile(filePath: string, crates: ReadonlyMap<string, RustPackage>): RustPackage | undefined {
  let best: RustPackage | undefined;
  for (const pkg of crates.values()) {
    if (relativeTo(pkg.dir, filePath) !== undefined && (!best || pkg.dir.length > best.dir.length)) best = pkg;
  }
  return best;
}

/** 相对目标根目录的路径转成模块路径：`a/b.rs`、`a/b/mod.rs` 都是 `a::b` */
export function modulePathOf(rel: string): string[] {
  const parts = rel.replace(/\.rs$/, '').split('/');
  if (parts[parts.length - 1] === 'mod') parts.pop();
  return parts.filter(Boolean);
}

/** 虚拟目标的种类；`src/bin/<dir>` 是 bin 之间共用的模块目录，不算 bin 目标 */
const VIRTUAL_KINDS: Record<string, RustTargetKind | undefined> = { tests: 'test', benches: 'bench', examples: 'example' };

function unitIn(target: Pick<RustTarget, 'name' | 'root'> & { kind?: RustTargetKind }, baseDir: string, filePath: string, packageDir: string): RustFileUnit {
  const rel = relativeTo(baseDir, filePath) ?? path.posix.basename(filePath);
  return { crate: rustCrateName(target.name), target: target.root, ...(target.kind ? { kind: target.kind } : {}), modulePath: modulePathOf(rel), packageDir };
}

/**
 * `tests/<dir>/...`、`src/bin/<dir>/...` 这类子目录：有 `<dir>/main.rs` 目标时归它，否则按目录名建虚拟目标
 * （各目标根文件的 `mod common;` 指向同目录下的 `common/mod.rs`，由多个目标共用）
 */
function subdirUnit(pkg: RustPackage, rel: string, filePath: string): RustFileUnit | undefined {
  const m = /^(tests|benches|examples|src\/bin)\/([^/]+)\//.exec(rel);
  if (!m) return undefined;
  const base = joinRel(pkg.dir, `${m[1]}/${m[2]}`);
  const real = pkg.targets.find((t) => t.root === `${base}/main.rs`);
  if (real) return unitIn(real, base, filePath, pkg.dir);
  return unitIn({ kind: VIRTUAL_KINDS[m[1]!], name: m[2]!, root: base }, base, filePath, pkg.dir);
}

/** `src/` 下的文件：有 lib 目标归 lib，否则归 `src/main.rs` 的 bin */
function srcUnit(pkg: RustPackage, rel: string, filePath: string): RustFileUnit | undefined {
  const owner = pkg.targets.find((t) => t.kind === 'lib') ?? pkg.targets.find((t) => t.kind === 'bin' && t.root === joinRel(pkg.dir, 'src/main.rs'));
  if (!owner) return undefined;
  const ownerDir = dirOf(owner.root);
  if (relativeTo(ownerDir, filePath) !== undefined) return unitIn(owner, ownerDir, filePath, pkg.dir);
  return rel.startsWith('src/') ? unitIn(owner, joinRel(pkg.dir, 'src'), filePath, pkg.dir) : undefined;
}

/** 不在任何目标里的文件：crate 名为所在目录名，模块路径为空 */
function looseUnit(filePath: string, packageDir?: string): RustFileUnit {
  const dir = dirOf(filePath);
  const crate = rustCrateName(dir ? path.posix.basename(dir) : path.posix.basename(filePath, '.rs'));
  return { crate, target: filePath, modulePath: [], ...(packageDir !== undefined ? { packageDir } : {}) };
}

/** 文件所属的 crate 目标和模块路径，只按路径和 Cargo.toml 计算，不看 `mod` 声明 */
export function rustFileUnit(filePath: string, crates: ReadonlyMap<string, RustPackage>): RustFileUnit {
  const pkg = packageForFile(filePath, crates);
  if (!pkg) return looseUnit(filePath);
  const own = pkg.targets.find((t) => t.root === filePath);
  if (own) return { crate: rustCrateName(own.name), target: own.root, kind: own.kind, modulePath: [], packageDir: pkg.dir };
  const rel = relativeTo(pkg.dir, filePath)!;
  return subdirUnit(pkg, rel, filePath) ?? srcUnit(pkg, rel, filePath) ?? looseUnit(filePath, pkg.dir);
}
