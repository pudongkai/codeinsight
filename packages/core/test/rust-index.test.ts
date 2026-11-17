import { beforeAll, describe, expect, it } from 'vitest';
import { deserializeExtractedFile, serializeExtractedFile } from '../src/extract/cache.js';
import { completeRustFiles, extractRustFile, getRustParser, rustCratesFromManifests } from '../src/index.js';
import type { ExtractedFile, ExtractedSymbol, ResolvedPath, RustSymbolIndex } from '../src/index.js';

const NO_FLAGS = { isTest: false, isGenerated: false };

const SOURCES: Record<string, string> = {
  'core/src/lib.rs': `pub mod order;
pub use order::service::Service;
pub fn root_fn() {}
`,
  'core/src/order/mod.rs': `pub mod repo;
pub mod service;
pub use repo::MemRepo as Store;
use super::*;
pub fn describe() { root_fn(); }
`,
  'core/src/order/repo.rs': `pub trait Repo {
    fn find(&self, id: u64) -> Option<String>;
}
pub struct MemRepo;
impl MemRepo {
    pub fn new() -> Self { MemRepo }
}
impl Repo for MemRepo {
    fn find(&self, id: u64) -> Option<String> { None }
}
pub fn build() -> MemRepo { MemRepo }
`,
  'core/src/order/service.rs': `use crate::order::repo::Repo;
pub struct Service<R: Repo> {
    repo: R,
}
impl<R: Repo> Service<R> {
    pub fn new(repo: R) -> Self { Service { repo } }
    pub fn create(&self, id: u64) -> Option<String> { self.repo.find(id) }
}
impl crate::order::repo::MemRepo {
    pub fn extra(&self) {}
}
mod inner {
    pub fn deep() {}
}
`,
  'app/src/main.rs': `use shop_core::order::repo::MemRepo;
use shop_core::Service;
use shop_core::order::Store;
fn main() {
    let svc = Service::new(MemRepo::new());
    svc.create(1);
    let built = shop_core::order::repo::build();
    built.extra();
    helper();
}
fn helper() {}
`,
  'app/tests/it.rs': `mod common;
fn t() { common::setup(); }
`,
  'app/tests/common/mod.rs': 'pub fn setup() {}\n',
  'app/src/bin/foo.rs': 'mod common;\nfn main() { common::g(); }\n',
  'app/src/bin/bar.rs': 'mod common;\nfn main() { common::g(); }\n',
  'app/src/bin/common/mod.rs': 'pub fn g() {}\n',
};

const CRATES = rustCratesFromManifests({
  manifests: new Map([
    ['Cargo.toml', '[workspace]\nmembers = ["core", "app"]\n'],
    ['core/Cargo.toml', '[package]\nname = "shop-core"\nversion = "0.1.0"\n'],
    ['app/Cargo.toml', '[package]\nname = "app"\nversion = "0.1.0"\n[dependencies]\nshop-core = { path = "../core" }\n'],
  ]),
  files: ['Cargo.toml', 'core/Cargo.toml', 'app/Cargo.toml', ...Object.keys(SOURCES)],
});

let files: Map<string, ExtractedFile>;
let index: RustSymbolIndex;

beforeAll(async () => {
  const parser = await getRustParser();
  files = new Map(Object.entries(SOURCES).map(([p, src]) => [p, extractRustFile(parser, p, src, NO_FLAGS, CRATES)]));
  index = completeRustFiles([...files.values()]);
});

function file(p: string): ExtractedFile {
  return files.get(p)!;
}

function sym(qn: string): ExtractedSymbol {
  for (const f of files.values()) {
    const s = f.symbols.find((x) => x.qualifiedName === qn);
    if (s) return s;
  }
  throw new Error(`no symbol ${qn}`);
}

/** 解析结果的简写：符号 `kind qualifiedName`，外部 crate `external:name` */
function resolved(p: string, segments: string[], mod?: string[]): string | undefined {
  const r: ResolvedPath | undefined = index.resolvePath(file(p), segments, mod);
  if (!r) return undefined;
  return 'external' in r ? `external:${r.external}` : `${r.symbol.kind} ${r.symbol.qualifiedName}`;
}

describe('RustSymbolIndex.resolvePath', () => {
  const service = 'core/src/order/service.rs';
  const main = 'app/src/main.rs';

  it('resolves crate, self and super prefixes', () => {
    expect(resolved(service, ['crate', 'order', 'repo', 'build'])).toBe('function shop_core::order::repo::build');
    expect(resolved(service, ['super', 'repo', 'build'])).toBe('function shop_core::order::repo::build');
    expect(resolved(service, ['self', 'Service'])).toBe('class shop_core::order::service::Service');
    expect(resolved(service, ['crate', 'order'])).toBe('module shop_core::order');
    expect(resolved(service, ['super', 'super'])).toBe('module shop_core');
  });

  it('resolves use bindings, workspace crates and items of the current module', () => {
    expect(resolved(service, ['Repo'])).toBe('interface shop_core::order::repo::Repo');
    expect(resolved(service, ['Repo', 'find'])).toBe('method shop_core::order::repo::Repo::find');
    expect(resolved(main, ['shop_core', 'order', 'repo', 'build'])).toBe('function shop_core::order::repo::build');
    expect(resolved(main, ['helper'])).toBe('function app::helper');
    expect(resolved(main, ['MemRepo', 'new'])).toBe('method shop_core::order::repo::MemRepo::new');
  });

  it('follows pub use re-exports, including renamed ones', () => {
    expect(resolved(main, ['Service'])).toBe('class shop_core::order::service::Service');
    expect(resolved(main, ['Store'])).toBe('class shop_core::order::repo::MemRepo');
    expect(resolved(main, ['shop_core', 'Service', 'create'])).toBe('method shop_core::order::service::Service::create');
  });

  it('resolves names brought in by glob uses and inline modules', () => {
    expect(resolved('core/src/order/mod.rs', ['root_fn'])).toBe('function shop_core::root_fn');
    expect(resolved(service, ['inner', 'deep'])).toBe('function shop_core::order::service::inner::deep');
    expect(resolved(service, ['deep'], ['inner'])).toBe('function shop_core::order::service::inner::deep');
  });

  it('resolves `mod common;` of an integration test to the tests/common target', () => {
    expect(resolved('app/tests/it.rs', ['common', 'setup'])).toBe('function common::setup');
  });

  it('resolves `mod common;` of several bins to the shared src/bin/common module', () => {
    expect(resolved('app/src/bin/bar.rs', ['common', 'g'])).toBe('function common::g');
    expect(resolved('app/src/bin/foo.rs', ['common', 'g'])).toBe('function common::g');
  });

  it('returns external for std and other crates, undefined for unknown single names', () => {
    expect(resolved(main, ['std', 'env', 'args'])).toBe('external:std');
    expect(resolved(main, ['serde_json', 'to_string'])).toBe('external:serde_json');
    expect(resolved(main, ['nope'])).toBeUndefined();
    expect(resolved(main, ['Self', 'x'])).toBeUndefined();
  });

  it('prefers a module of the current crate over a workspace crate with the same name', async () => {
    const parser = await getRustParser();
    const crates = rustCratesFromManifests({
      manifests: new Map([
        ['Cargo.toml', '[workspace]\nmembers = ["a", "config"]\n'],
        ['a/Cargo.toml', '[package]\nname = "a"\n[dependencies]\nconfig = { path = "../config" }\n'],
        ['config/Cargo.toml', '[package]\nname = "config"\n'],
      ]),
      files: ['Cargo.toml', 'a/Cargo.toml', 'config/Cargo.toml', 'a/src/lib.rs', 'a/src/config.rs', 'config/src/lib.rs'],
    });
    const fs = [
      extractRustFile(parser, 'a/src/lib.rs', 'mod config;\npub fn run() { config::load(); }\n', NO_FLAGS, crates),
      extractRustFile(parser, 'a/src/config.rs', 'pub fn load() {}\n', NO_FLAGS, crates),
      extractRustFile(parser, 'config/src/lib.rs', 'pub fn load() {}\n', NO_FLAGS, crates),
    ];
    const idx = completeRustFiles(fs);
    expect(idx.resolvePath(fs[0]!, ['config', 'load'])).toMatchObject({ file: { path: 'a/src/config.rs' } });
  });

  it('applies the uses of an inline mod only inside that mod', async () => {
    const parser = await getRustParser();
    const crates = rustCratesFromManifests({ manifests: new Map([['Cargo.toml', '[package]\nname = "m"\n']]), files: ['Cargo.toml', 'src/lib.rs'] });
    const src = 'pub mod config { pub fn load() {} }\nmod tests { use crate::config::load as run2; }\n';
    const lib = extractRustFile(parser, 'src/lib.rs', src, NO_FLAGS, crates);
    const idx = completeRustFiles([lib]);
    expect(idx.resolvePath(lib, ['run2'], ['tests'])).toMatchObject({ symbol: { qualifiedName: 'm::config::load' } });
    expect(idx.resolvePath(lib, ['run2'])).toBeUndefined();
  });

  it('stops following re-exports after three levels', async () => {
    const parser = await getRustParser();
    const crates = rustCratesFromManifests({ manifests: new Map([['Cargo.toml', '[package]\nname = "deep"\n']]), files: ['Cargo.toml', 'src/lib.rs'] });
    const src = [
      'pub mod a { pub use super::b::A2 as A1; }', 'pub mod b { pub use super::c::A3 as A2; }',
      'pub mod c { pub use super::d::A4 as A3; }', 'pub mod d { pub struct A4; }', 'pub mod e { pub use super::a::A1 as A0; }',
    ].join('\n');
    const lib = extractRustFile(parser, 'src/lib.rs', src, NO_FLAGS, crates);
    const other = extractRustFile(parser, 'src/main.rs', 'fn main() {}\n', NO_FLAGS, crates);
    const idx = completeRustFiles([lib, other]);
    expect(idx.resolvePath(other, ['deep', 'a', 'A1'])).toMatchObject({ symbol: { name: 'A4' } });
    expect(idx.resolvePath(other, ['deep', 'e', 'A0'])).toBeUndefined();
  });
});

describe('completeRustFiles', () => {
  it('links impl methods to a type defined in another file of the same crate target', () => {
    expect(sym('shop_core::order::service::MemRepo::extra').parentId).toBe(sym('shop_core::order::repo::MemRepo').id);
  });

  it('fills receiver types across files: generic bounds, constructor results and function results', () => {
    const callAt = (p: string, name: string) => file(p).rust!.calls.find((c) => c.form === 'method' && c.segments[0] === name)!;
    expect(callAt('core/src/order/service.rs', 'find').receiverType).toBe(sym('shop_core::order::repo::Repo').id);
    expect(callAt('app/src/main.rs', 'create').receiverType).toBe(sym('shop_core::order::service::Service').id);
    expect(callAt('app/src/main.rs', 'extra').receiverType).toBe(sym('shop_core::order::repo::MemRepo').id);
  });

  it('finds methods by type and by name', () => {
    const memRepo = sym('shop_core::order::repo::MemRepo').id;
    expect(index.method(memRepo, 'find')?.qualifiedName).toBe('shop_core::order::repo::<MemRepo as Repo>::find');
    expect(index.method(memRepo, 'extra')?.qualifiedName).toBe('shop_core::order::service::MemRepo::extra');
    expect(index.methodsNamed('find').map((m) => m.qualifiedName).sort()).toEqual([
      'shop_core::order::repo::<MemRepo as Repo>::find', 'shop_core::order::repo::Repo::find',
    ]);
  });

  it('keeps the Rust facts through the extract cache', () => {
    const back = deserializeExtractedFile(serializeExtractedFile(file('app/src/main.rs')));
    expect(back.rust!.uses).toMatchObject({ Service: ['shop_core', 'Service'] });
    expect(back.rust!.calls.length).toBeGreaterThan(0);
  });
});
