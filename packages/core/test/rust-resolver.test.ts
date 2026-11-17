import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSnapshot, initDataDir, loadConfig, Store } from '../src/index.js';
import type { BuildSnapshotResult, EdgeRow, Resolver, SymbolRow } from '../src/index.js';
import { FAILED_RERESOLVE_AFTER_MS } from '../src/resolve/edge-sources.js';
import { LanguageResolver } from '../src/resolve/language-resolver.js';
import { setLogSink } from '../src/log.js';
import { RUST_RESOLVER_MODULES, RustResolver } from '../src/resolve/rust.js';
import { findRustTools, type RustToolsLookup } from '../src/resolve/rust-tools.js';
import { commitAll, git, tempDir } from './helpers/git-repo.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'rust-basic');
const CORE = 'shop_core::order';
const hasRust = (await findRustTools({ runBase: tempDir('ci-rust-base-') })).ok;

function fixtureRepo(extra: Record<string, string> = {}): string {
  const repo = tempDir('ci-rust-resolve-');
  cpSync(FIXTURE, repo, { recursive: true });
  for (const [p, text] of Object.entries(extra)) {
    mkdirSync(path.dirname(path.join(repo, p)), { recursive: true });
    writeFileSync(path.join(repo, p), text);
  }
  git(repo, 'init', '-q', '-b', 'main');
  commitAll(repo, 'init');
  return repo;
}

async function setup(resolver: () => Resolver, extra?: Record<string, string>) {
  const repo = fixtureRepo(extra);
  const config = await loadConfig(repo, { dataDir: tempDir('ci-rust-resolve-data-') });
  const layout = await initDataDir(config.dataDir);
  const store = new Store(layout.dbPath);
  const build = (): Promise<BuildSnapshotResult> => buildSnapshot({ repo, store, layout, config, resolver: resolver() });
  return { repo, store, layout, build };
}

function describeEdges(edges: EdgeRow[], symbols: SymbolRow[]): string[] {
  const qn = new Map(symbols.map((s) => [s.id, s.qualifiedName]));
  return edges.map((e) => `${e.kind} ${qn.get(e.srcId)} -> ${qn.get(e.dstId)}`);
}

/** import 边按（源文件，目标文件）去重 */
function importFiles(edges: EdgeRow[], symbols: SymbolRow[]): string[] {
  const file = new Map(symbols.map((s) => [s.id, s.path]));
  return [...new Set(edges.filter((e) => e.kind === 'import').map((e) => `${file.get(e.srcId)} -> ${file.get(e.dstId)}`))].sort();
}

const rustOnly = (scip: boolean): Resolver => new LanguageResolver({ rust: new RustResolver({ scip }) });

describe('Rust resolver with name matching', () => {
  it('stores cross-crate call and import edges, and a retried resolve yields the same edges', async () => {
    const env = await setup(() => rustOnly(false));
    const first = await env.build();
    expect(first.snapshot).toMatchObject({ resolverStatus: 'ok' });
    expect(first.snapshot.edgeSources?.rust).toMatchObject({ source: 'name_match', reason: 'disabled' });
    const edges = env.store.getEdges(first.snapshot.id);
    const symbols = env.store.getSymbols(first.snapshot.id);
    const text = describeEdges(edges, symbols);
    expect(text).toContain(`call app::main -> ${CORE}::service::Service::create`);
    expect(text).toContain(`call ${CORE}::service::Service::create -> ${CORE}::repo::Repo::find`);
    expect(importFiles(edges, symbols)).toContain('crates/app/src/main.rs -> crates/core/src/order/service.rs');
    expect(edges.every((e) => e.provenance === 'name_match')).toBe(true);

    env.store.setSnapshotStatus(first.snapshot.id, { resolverStatus: 'failed', resolverError: 'boom' });
    const retried = await env.build();
    expect(retried.resolveRetried).toBe(true);
    expect(env.store.getEdges(retried.snapshot.id)).toHaveLength(edges.length);
  }, 120_000);
});

describe('Rust resolver needsReresolve', () => {
  /** 不运行外部命令，直接设定工具查找的结果 */
  function withTools(lookup: RustToolsLookup): RustResolver {
    const r = new RustResolver();
    (r as unknown as { tools: RustToolsLookup }).tools = lookup;
    return r;
  }

  const found = withTools({
    ok: true,
    tools: { cargo: '/c', rustAnalyzer: '/ra', rustc: '/rc', version: 'rust-analyzer 9.9.9', rustSrc: true, trueBin: '/usr/bin/true' },
  });
  const missing = withTools({ ok: false, reason: 'not_found', detail: 'rust-analyzer: not found' });

  it('re-resolves a not_found fallback once rust-analyzer is found, and not while it is still missing', async () => {
    const sources = { rust: { source: 'name_match' as const, reason: 'not_found' as const, at: Date.now() } };
    expect(found.version).toMatch(/^rust-analyzer@rust-analyzer 9\.9\.9:/);
    expect(await found.needsReresolve(sources)).toBe(true);
    expect(missing.version).toMatch(/^name-match:/);
    expect(await missing.needsReresolve(sources)).toBe(false);
  });

  it('re-resolves a failed fallback only after the retry interval', async () => {
    const now = Date.now();
    const failedAt = (at: number) => ({ rust: { source: 'name_match' as const, reason: 'failed' as const, at } });
    expect(await found.needsReresolve(failedAt(now - FAILED_RERESOLVE_AFTER_MS - 1), now)).toBe(true);
    expect(await found.needsReresolve(failedAt(now - 1000), now)).toBe(false);
  });

  it('keeps disabled, no_module and scip results', async () => {
    expect(await found.needsReresolve({ rust: { source: 'name_match', reason: 'disabled', at: 0 } })).toBe(false);
    expect(await found.needsReresolve({ rust: { source: 'name_match', reason: 'no_module', at: 0 } })).toBe(false);
    expect(await found.needsReresolve({ rust: { source: 'scip' } })).toBe(false);
  });
});

describe('Rust resolver without Cargo.toml', () => {
  it('falls back to name matching with reason no_module', async () => {
    const r = new RustResolver();
    (r as unknown as { tools: RustToolsLookup }).tools = {
      ok: true, tools: { cargo: '/c', rustAnalyzer: '/ra', rustc: '/rc', version: 'x', rustSrc: true, trueBin: '/usr/bin/true' },
    };
    const repo = tempDir('ci-rust-nocargo-');
    writeFileSync(path.join(repo, 'main.rs'), 'fn main() { helper(); }\nfn helper() {}\n');
    git(repo, 'init', '-q', '-b', 'main');
    commitAll(repo, 'init');
    const config = await loadConfig(repo, { dataDir: tempDir('ci-rust-nocargo-data-') });
    const layout = await initDataDir(config.dataDir);
    const store = new Store(layout.dbPath);
    const snap = await buildSnapshot({ repo, store, layout, config, resolver: new LanguageResolver({ rust: r }) });
    expect(snap.snapshot.edgeSources?.rust).toMatchObject({ source: 'name_match', reason: 'no_module' });
    expect(describeEdges(store.getEdges(snap.snapshot.id), store.getSymbols(snap.snapshot.id))).toContain('call main::main -> main::helper');
  }, 60_000);
});

describe('Rust resolver without a runnable cargo root', () => {
  it('records no_module without running cargo when every package is test data or an example', async () => {
    const r = new RustResolver();
    (r as unknown as { tools: RustToolsLookup }).tools = {
      ok: true, tools: { cargo: '/nonexistent/cargo', rustAnalyzer: '/ra', rustc: '/rc', version: 'x', rustSrc: true, trueBin: '/usr/bin/true' },
    };
    const repo = tempDir('ci-rust-noroot-');
    mkdirSync(path.join(repo, 'examples/demo/src'), { recursive: true });
    writeFileSync(path.join(repo, 'examples/demo/Cargo.toml'), '[package]\nname = "demo"\nversion = "0.1.0"\n');
    writeFileSync(path.join(repo, 'examples/demo/src/main.rs'), 'fn main() { helper(); }\nfn helper() {}\n');
    git(repo, 'init', '-q', '-b', 'main');
    commitAll(repo, 'init');
    const config = await loadConfig(repo, { dataDir: tempDir('ci-rust-noroot-data-') });
    const layout = await initDataDir(config.dataDir);
    const store = new Store(layout.dbPath);
    const snap = await buildSnapshot({ repo, store, layout, config, resolver: new LanguageResolver({ rust: r }) });
    expect(snap.snapshot.edgeSources?.rust).toMatchObject({ source: 'name_match', reason: 'no_module', note: expect.stringContaining('no cargo root') });
    expect(await r.needsReresolve(snap.snapshot.edgeSources!, Date.now() + 2 * FAILED_RERESOLVE_AFTER_MS)).toBe(false);
  }, 60_000);
});

/** 工具固定为一个启动不了的 cargo，所有运行根目录都会失败 */
function failingResolver(): RustResolver {
  const r = new RustResolver();
  r.prepare = async () => {};
  (r as unknown as { tools: RustToolsLookup }).tools = {
    ok: true, tools: { cargo: '/nonexistent/cargo', rustAnalyzer: '/ra', rustc: '/rc', version: 'x', rustSrc: true, trueBin: '/usr/bin/true' },
  };
  return r;
}

function findFile(dir: string, suffix: string): string | undefined {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findFile(p, suffix);
      if (hit) return hit;
    } else if (e.name.endsWith(suffix)) return p;
  }
  return undefined;
}

describe('Rust resolver failures', () => {
  function repoWith(files: Record<string, string>): string {
    const repo = tempDir('ci-rust-fail-');
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(repo, p)), { recursive: true });
      writeFileSync(path.join(repo, p), text);
    }
    git(repo, 'init', '-q', '-b', 'main');
    commitAll(repo, 'init');
    return repo;
  }

  it('keeps the failure time recorded in the cache when every root failed', async () => {
    const repo = repoWith({ 'Cargo.toml': '[package]\nname = "a"\nversion = "0.1.0"\n', 'src/lib.rs': 'pub fn f() { g(); }\nfn g() {}\n' });
    const config = await loadConfig(repo, { dataDir: tempDir('ci-rust-fail-data-') });
    const layout = await initDataDir(config.dataDir);
    let store = new Store(layout.dbPath);
    const first = await buildSnapshot({ repo, store, layout, config, resolver: new LanguageResolver({ rust: failingResolver() }) });
    expect(first.snapshot.edgeSources?.rust).toMatchObject({ source: 'name_match', reason: 'failed' });
    const meta = findFile(config.dataDir, '.rust.json')!;
    const cached = JSON.parse(readFileSync(meta, 'utf8')) as { at: number };
    expect(first.snapshot.edgeSources?.rust?.at).toBe(cached.at);
    const earlier = cached.at - 10 * 60_000;
    writeFileSync(meta, JSON.stringify({ ...cached, at: earlier }));
    store.close();
    rmSync(layout.dbPath, { force: true });
    store = new Store(layout.dbPath);
    const second = await buildSnapshot({ repo, store, layout, config, resolver: new LanguageResolver({ rust: failingResolver() }) });
    expect(second.snapshot.edgeSources?.rust).toMatchObject({ source: 'name_match', reason: 'failed', at: earlier });
    store.close();
  }, 60_000);

  it('logs only the first line of a Cargo.toml parse error', async () => {
    const repo = repoWith({
      'Cargo.toml': '[package]\nname = "a"\nsecret = "TOPSECRET" x\n', 'src/lib.rs': 'pub fn f() {}\n',
      'b/Cargo.toml': '[package]\nname = "b"\nversion = "0.1.0"\n', 'b/src/lib.rs': 'pub fn h() {}\n',
    });
    const config = await loadConfig(repo, { dataDir: tempDir('ci-rust-fail-data-') });
    const layout = await initDataDir(config.dataDir);
    const store = new Store(layout.dbPath);
    const lines: string[] = [];
    const restore = setLogSink((l) => lines.push(l));
    try {
      await buildSnapshot({ repo, store, layout, config, resolver: new LanguageResolver({ rust: failingResolver() }) });
    } finally {
      setLogSink(restore);
      store.close();
    }
    const skipped = lines.filter((l) => l.includes('rust_cargo_toml_skipped'));
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((l) => !l.includes('TOPSECRET'))).toBe(true);
  }, 60_000);

  it('includes the Cargo parsing module in the resolver fingerprint', () => {
    expect(RUST_RESOLVER_MODULES).toContain('extract/rust-cargo');
  });
});

describe.skipIf(!hasRust)('Rust resolver with rust-analyzer', () => {
  it('stores scip edges, with import edges to the same files as name matching', async () => {
    const env = await setup(() => rustOnly(true));
    const snap = await env.build();
    expect(snap.snapshot).toMatchObject({ resolverStatus: 'ok' });
    expect(snap.snapshot.edgeSources?.rust?.source).toBe('scip');
    const edges = env.store.getEdges(snap.snapshot.id);
    const symbols = env.store.getSymbols(snap.snapshot.id);
    expect(describeEdges(edges, symbols)).toContain(`call app::main -> ${CORE}::service::Service::create`);
    expect(edges.some((e) => e.provenance === 'scip')).toBe(true);

    const nm = await setup(() => rustOnly(false));
    const nmSnap = await nm.build();
    const nmImports = importFiles(nm.store.getEdges(nmSnap.snapshot.id), nm.store.getSymbols(nmSnap.snapshot.id));
    expect(importFiles(edges, symbols)).toEqual(nmImports);
  }, 180_000);

  it('falls back for a failing cargo root only, keeping scip edges of the other root', async () => {
    const env = await setup(() => rustOnly(true), {
      'broken/Cargo.toml': '[package]\nname = "broken"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nnope = { path = "../nope" }\n',
      'broken/src/lib.rs': 'pub fn run() { helper(); }\nfn helper() {}\n',
    });
    const snap = await env.build();
    const rust = snap.snapshot.edgeSources?.rust;
    expect(rust).toMatchObject({ source: 'name_match', reason: 'failed' });
    expect(rust?.note).toContain('broken');
    const edges = env.store.getEdges(snap.snapshot.id);
    const symbols = env.store.getSymbols(snap.snapshot.id);
    const path = new Map(symbols.map((s) => [s.id, s.path]));
    expect(edges.filter((e) => path.get(e.srcId)?.startsWith('crates/')).every((e) => e.provenance === 'scip')).toBe(true);
    const broken = edges.filter((e) => path.get(e.srcId) === 'broken/src/lib.rs');
    expect(broken.length).toBeGreaterThan(0);
    expect(broken.every((e) => e.provenance === 'name_match')).toBe(true);
  }, 180_000);
});
