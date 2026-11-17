import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSnapshot, initDataDir, loadConfig, runReview, setLogSink, Store } from '../src/index.js';
import type { BuildSnapshotResult, CodeInsightConfig, DataDirLayout, ExtractedFile, FileRow, Resolver, SymbolRow } from '../src/index.js';
import { LanguageResolver } from '../src/resolve/language-resolver.js';
import { RustResolver } from '../src/resolve/rust.js';
import { snapshotDir } from '../src/store/data-dir.js';
import { commitAll, git, tempDir } from './helpers/git-repo.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'rust-basic');
const CORE = 'shop_core::order';

/** 这里只检查提取和快照，调用边用名称匹配，不运行 rust-analyzer */
const nameMatch = (): Resolver => new LanguageResolver({ rust: new RustResolver({ scip: false }) });

function fixtureRepo(): string {
  const repo = tempDir('ci-rust-fixture-');
  cpSync(FIXTURE, repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  commitAll(repo, 'init');
  return repo;
}

/** 记录每次解析输入的文件，可以让第一次解析失败 */
function capturingResolver(seen: ExtractedFile[][], fail: boolean): Resolver {
  return {
    name: 'capture', version: '1',
    resolve: async (input) => {
      seen.push(input.files);
      if (fail) throw new Error('boom');
      return { edges: [] };
    },
  };
}

describe('snapshot build of a Rust repository', () => {
  let repo: string;
  let store: Store;
  let layout: DataDirLayout;
  let config: CodeInsightConfig;
  let first: BuildSnapshotResult;
  let files: Map<string, FileRow>;
  let symbols: SymbolRow[];

  beforeAll(async () => {
    repo = fixtureRepo();
    config = await loadConfig(repo, { dataDir: tempDir('ci-rust-data-') });
    layout = await initDataDir(config.dataDir);
    store = new Store(layout.dbPath);
    first = await buildSnapshot({ repo, store, layout, config, resolver: nameMatch() });
    files = new Map(store.getFiles(first.snapshot.id).map((f) => [f.path, f]));
    symbols = store.getSymbols(first.snapshot.id);
  }, 120_000);

  it('stores Rust items with crate and module qualified names', () => {
    expect(first.snapshot.extractStatus).toBe('ok');
    const byQn = new Map(symbols.map((s) => [`${s.kind} ${s.qualifiedName}`, s]));
    const service = byQn.get(`class ${CORE}::service::Service`)!;
    expect(byQn.get(`method ${CORE}::service::Service::create`)).toMatchObject({ path: 'crates/core/src/order/service.rs', parentId: service.id });
    const repoTrait = byQn.get(`interface ${CORE}::repo::Repo`)!;
    expect(byQn.get(`method ${CORE}::repo::Repo::find`)!.parentId).toBe(repoTrait.id);
    expect(byQn.get(`method ${CORE}::repo::<MemRepo as Repo>::find`)!.parentId).toBe(byQn.get(`class ${CORE}::repo::MemRepo`)!.id);
    const u8 = byQn.get(`method ${CORE}::repo::<Foo as From<u8>>::from`)!;
    const u16 = byQn.get(`method ${CORE}::repo::<Foo as From<u16>>::from`)!;
    expect(u8.id).not.toBe(u16.id);
    expect(byQn.get(`function ${CORE}::service::helpers::type`)).toBeDefined();
    expect(byQn.get('module app')?.path).toBe('crates/app/src/main.rs');
    expect(byQn.get('module tool')?.path).toBe('crates/app/src/bin/tool.rs');
    expect(byQn.get('module shop_core')?.docstring).toBe('Shop core library: orders and repositories.');
    expect(first.snapshot.edgeSources?.rust).toMatchObject({ source: 'name_match', reason: 'disabled' });
  });

  it('stores a cli entry for each bin target main', () => {
    const byId = new Map(symbols.map((s) => [s.id, s]));
    const mains = store.getEntries(first.snapshot.id)
      .filter((e) => e.kind === 'cli' && e.framework === 'rust')
      .map((e) => byId.get(e.symbolId)?.path)
      .sort();
    expect(mains).toEqual(['crates/app/src/bin/tool.rs', 'crates/app/src/main.rs']);
  });

  it('marks integration tests and cfg(test) functions as tests', () => {
    const fn = (qn: string) => symbols.find((s) => s.qualifiedName === qn)!;
    expect(fn('it::create_works').isTest).toBe(true);
    expect(fn('common::setup').isTest).toBe(true);
    expect(fn('shop_core::tests::creates_order').isTest).toBe(true);
    expect(fn('shop_core::default_service').isTest).toBe(false);
    expect(files.get('crates/core/tests/it.rs')).toMatchObject({ isTest: true });
  });

  it('classifies target/ and vendor/ next to a Cargo.toml as unsupported, and generated files', () => {
    expect(files.get('crates/core/target/debug/x.rs')).toMatchObject({ language: 'rust', supportLevel: 'none' });
    expect(files.get('vendor/dep/src/lib.rs')).toMatchObject({ language: 'rust', supportLevel: 'none' });
    expect(files.get('crates/core/src/vendor/mod.rs')).toMatchObject({ language: 'rust', supportLevel: 'full' });
    expect(files.get('crates/core/src/gen.rs')).toMatchObject({ isGenerated: true });
    expect(symbols.some((s) => s.path.includes('/target/') || s.path.startsWith('vendor/'))).toBe(false);
  });

  it('places Cargo files and Rust sources, but not excluded directories, into the snapshot directory', () => {
    const dir = snapshotDir(layout, first.snapshot.contentKey);
    expect(readFileSync(path.join(dir, 'crates/core/Cargo.toml'), 'utf8')).toContain('shop-core');
    expect(existsSync(path.join(dir, 'crates/core/src/order/service.rs'))).toBe(true);
    expect(existsSync(path.join(dir, 'crates/core/target/debug/x.rs'))).toBe(false);
    expect(existsSync(path.join(dir, 'vendor/dep/src/lib.rs'))).toBe(false);
  });

  it('copies Cargo.toml instead of linking it to the previous snapshot', async () => {
    writeFileSync(path.join(repo, 'crates/core/src/extra.rs'), 'pub fn extra() {}\n');
    const second = await buildSnapshot({ repo, store, layout, config, resolver: nameMatch() });
    expect(second.snapshot.id).not.toBe(first.snapshot.id);
    const dir = snapshotDir(layout, second.snapshot.contentKey);
    expect(lstatSync(path.join(dir, 'crates/core/Cargo.toml')).nlink).toBe(1);
    expect(lstatSync(path.join(dir, 'crates/core/src/order/service.rs')).nlink).toBeGreaterThan(1);
  }, 120_000);
});

describe('Cargo files that are symlinks or invalid', () => {
  it('does not read symlinked Cargo.toml and logs TOML errors without source lines', async () => {
    const repo = fixtureRepo();
    writeFileSync(path.join(repo, 'secret.env'), '[package]\nname = "leaked"\n# aws_secret_access_key = abc123\n');
    mkdirSync(path.join(repo, 'crates/leak/src'), { recursive: true });
    symlinkSync('../../secret.env', path.join(repo, 'crates/leak/Cargo.toml'));
    writeFileSync(path.join(repo, 'crates/leak/src/lib.rs'), 'pub fn leak() {}\n');
    mkdirSync(path.join(repo, 'crates/bad/src'), { recursive: true });
    writeFileSync(path.join(repo, 'crates/bad/Cargo.toml'), 'token = "s3cr3t" y\n');
    writeFileSync(path.join(repo, 'crates/bad/src/lib.rs'), 'pub fn bad() {}\n');
    const config = await loadConfig(repo, { dataDir: tempDir('ci-rust-data-') });
    const layout = await initDataDir(config.dataDir);
    const store = new Store(layout.dbPath);
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));
    let built: BuildSnapshotResult;
    try {
      built = await buildSnapshot({ repo, store, layout, config, resolver: nameMatch() });
    } finally {
      setLogSink(restore);
    }
    const leak = store.getSymbols(built.snapshot.id).find((s) => s.name === 'leak')!;
    expect(leak.qualifiedName).toBe('src::leak');
    expect(lines.join('\n')).not.toMatch(/abc123|s3cr3t/);
    expect(lines.filter((l) => l.includes('cargo_toml_invalid'))).toEqual([expect.stringMatching(/crates\/bad\/Cargo\.toml.*line 1/)]);
  }, 120_000);
});

describe('Cargo.lock in commit snapshots', () => {
  it('copies an ignored Cargo.lock from the working tree when the commit has none', async () => {
    const repo = fixtureRepo();
    writeFileSync(path.join(repo, '.gitignore'), 'Cargo.lock\n');
    commitAll(repo, 'ignore lock');
    writeFileSync(path.join(repo, 'Cargo.lock'), '# lock\nversion = 4\n');
    const config = await loadConfig(repo, { dataDir: tempDir('ci-rust-data-') });
    const layout = await initDataDir(config.dataDir);
    const store = new Store(layout.dbPath);
    const built = await buildSnapshot({ repo, store, layout, config, ref: 'HEAD', resolver: nameMatch() });
    const dir = snapshotDir(layout, built.snapshot.contentKey);
    expect(readFileSync(path.join(dir, 'Cargo.lock'), 'utf8')).toContain('version = 4');
    expect(existsSync(path.join(dir, 'crates/core/Cargo.lock'))).toBe(false);
    const working = await buildSnapshot({ repo, store, layout, config, resolver: nameMatch() });
    expect(existsSync(path.join(snapshotDir(layout, working.snapshot.contentKey), 'Cargo.lock'))).toBe(true);
  }, 120_000);
});

describe('retrying resolve on a Rust snapshot', () => {
  it('restores Rust files with the rust field rebuilt from the snapshot Cargo.toml', async () => {
    const repo = fixtureRepo();
    const config = await loadConfig(repo, { dataDir: tempDir('ci-rust-data-') });
    const layout = await initDataDir(config.dataDir);
    const store = new Store(layout.dbPath);
    const seen: ExtractedFile[][] = [];
    const failed = await buildSnapshot({ repo, store, layout, config, ref: 'HEAD', resolver: capturingResolver(seen, true) });
    expect(failed.snapshot.resolverStatus).toBe('failed');
    const retried = await buildSnapshot({ repo, store, layout, config, ref: 'HEAD', resolver: capturingResolver(seen, false) });
    expect(retried.resolveRetried).toBe(true);
    const rust = (list: ExtractedFile[]) => new Map(list.filter((f) => f.language === 'rust').map((f) => [f.path, f.rust]));
    const [extracted, restored] = [rust(seen[0]!), rust(seen[1]!)];
    expect(restored.size).toBeGreaterThan(5);
    expect(restored).toEqual(extracted);
    expect(restored.get('crates/core/tests/common/mod.rs')).toMatchObject({ crate: 'common', target: 'crates/core/tests/common' });
  }, 120_000);
});

describe('Rust facts read back from the extract cache', () => {
  it('keeps use bindings and fills receiver types for cached files', async () => {
    const repo = fixtureRepo();
    const config = await loadConfig(repo, { dataDir: tempDir('ci-rust-data-') });
    const layout = await initDataDir(config.dataDir);
    const store = new Store(layout.dbPath);
    const seen: ExtractedFile[][] = [];
    await buildSnapshot({ repo, store, layout, config, resolver: capturingResolver(seen, false) });
    writeFileSync(path.join(repo, 'crates/core/src/extra.rs'), 'pub fn extra() {}\n');
    await buildSnapshot({ repo, store, layout, config, resolver: capturingResolver(seen, false) });
    expect(seen).toHaveLength(2);
    const main = seen[1]!.find((f) => f.path === 'crates/app/src/main.rs')!;
    expect(main.rust!.uses).toMatchObject({ Service: ['shop_core', 'order', 'service', 'Service'] });
    const service = symbolsOf(seen[0]!).get('shop_core::order::service::Service')!;
    expect(main.rust!.calls.find((c) => c.segments[0] === 'create')?.receiverType).toBe(service.id);
  }, 120_000);
});

function symbolsOf(list: ExtractedFile[]): Map<string, { id: string }> {
  return new Map(list.flatMap((f) => f.symbols.map((s) => [s.qualifiedName, s] as const)));
}

describe('reviewing Rust changes', () => {
  it('reports .rs changes under target/ with the support level recorded in the snapshot', async () => {
    const repo = fixtureRepo();
    const config = await loadConfig(repo, { dataDir: tempDir('ci-rust-data-'), env: {} });
    const layout = await initDataDir(config.dataDir);
    const store = new Store(layout.dbPath);
    writeFileSync(path.join(repo, 'crates/core/target/debug/x.rs'), 'pub fn build_output() { let _ = 1; }\n');
    writeFileSync(path.join(repo, 'crates/core/src/gen.rs'), '// @generated\npub fn generated_id() -> u64 { 43 }\n');
    const report = await runReview({ repo, store, layout, config, working: true, resolver: nameMatch() });
    const byPath = new Map(report.files.map((f) => [f.path, f]));
    expect(byPath.get('crates/core/target/debug/x.rs')).toMatchObject({ language: 'rust', supportLevel: 'none' });
    expect(byPath.get('crates/core/src/gen.rs')).toMatchObject({ language: 'rust', supportLevel: 'full' });
    expect(report.warnings.some((w) => w.code === 'language_unsupported' && w.path === 'crates/core/target/debug/x.rs')).toBe(true);
  }, 120_000);
});
