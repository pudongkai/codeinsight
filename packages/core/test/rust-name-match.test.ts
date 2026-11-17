import { beforeAll, describe, expect, it } from 'vitest';
import { completeRustFiles, extractRustFile, getRustParser, rustCratesFromManifests } from '../src/index.js';
import type { EdgeRow, ExtractedFile } from '../src/index.js';
import { rustNameMatchEdges } from '../src/resolve/rust-name-match.js';

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
pub fn describe() { root_fn(); self::local(); }
fn local() { super::root_fn(); crate::root_fn(); }
`,
  'core/src/order/repo.rs': `pub trait Repo {
    fn find(&self, id: u64) -> Option<String>;
}
pub struct MemRepo;
impl MemRepo {
    pub fn new() -> Self { MemRepo }
    pub fn reset(&self) {}
    pub fn fresh() -> Self { Self::new() }
}
impl Repo for MemRepo {
    fn find(&self, id: u64) -> Option<String> { None }
}
pub struct Other;
impl Other {
    pub fn reset(&self) {}
}
`,
  'core/src/order/service.rs': `use crate::order::repo::Repo;
use crate::order::repo::MemRepo as Mem;
pub struct Service<R: Repo> {
    repo: R,
}
impl<R: Repo> Service<R> {
    pub fn new(repo: R) -> Self { Service { repo } }
    pub fn create(&self, id: u64) -> Option<String> { self.repo.find(id) }
}
pub fn build() -> Mem { Mem::new() }
`,
  'app/src/main.rs': `use shop_core::order::Store;
use shop_core::Service;
fn main() {
    let svc = Service::new(Store::new());
    svc.create(1);
    let m = Store::fresh();
    m.reset();
    unknown().only_here();
    unknown().reset();
    std::mem::drop(1);
}
fn only() {}
`,
  'app/src/extra.rs': `pub struct Z;
impl Z {
    pub fn only_here(&self) {}
}
`,
};

const CRATES = rustCratesFromManifests({
  manifests: new Map([
    ['Cargo.toml', '[workspace]\nmembers = ["core", "app"]\n'],
    ['core/Cargo.toml', '[package]\nname = "shop-core"\nversion = "0.1.0"\n'],
    ['app/Cargo.toml', '[package]\nname = "app"\nversion = "0.1.0"\n[dependencies]\nshop-core = { path = "../core" }\n'],
  ]),
  files: ['Cargo.toml', 'core/Cargo.toml', 'app/Cargo.toml', ...Object.keys(SOURCES)],
});

let files: ExtractedFile[];
let edges: EdgeRow[];
let text: string[];

/** 边的简写：`kind 源 qualifiedName -> 目标 qualifiedName (置信度)` */
function describeEdges(all: EdgeRow[]): string[] {
  const qn = new Map(files.flatMap((f) => f.symbols.map((s) => [s.id, s.qualifiedName] as const)));
  return all.map((e) => `${e.kind} ${qn.get(e.srcId)} -> ${qn.get(e.dstId)} (${e.confidence})`);
}

beforeAll(async () => {
  const parser = await getRustParser();
  files = Object.entries(SOURCES).map(([p, src]) => extractRustFile(parser, p, src, NO_FLAGS, CRATES));
  completeRustFiles(files);
  edges = await rustNameMatchEdges(files, 1, new Map(Object.entries(SOURCES)));
  text = describeEdges(edges);
});

describe('Rust name matching calls', () => {
  it('resolves path calls through crate/self/super, glob uses and workspace crates', () => {
    expect(text).toContain('call shop_core::order::describe -> shop_core::root_fn (high)');
    expect(text).toContain('call shop_core::order::describe -> shop_core::order::local (high)');
    expect(text.filter((t) => t === 'call shop_core::order::local -> shop_core::root_fn (high)')).toHaveLength(2);
  });

  it('resolves use aliases, pub use re-exports, Type::new and Self::m', () => {
    expect(text).toContain('call shop_core::order::service::build -> shop_core::order::repo::MemRepo::new (high)');
    expect(text).toContain('call app::main -> shop_core::order::service::Service::new (high)');
    expect(text).toContain('call app::main -> shop_core::order::repo::MemRepo::new (high)');
    expect(text).toContain('call shop_core::order::repo::MemRepo::fresh -> shop_core::order::repo::MemRepo::new (high)');
  });

  it('links method calls on inferred receiver types and trait-bound fields', () => {
    expect(text).toContain('call app::main -> shop_core::order::service::Service::create (high)');
    expect(text).toContain('call app::main -> shop_core::order::repo::MemRepo::reset (high)');
    expect(text).toContain('call shop_core::order::service::Service::create -> shop_core::order::repo::Repo::find (high)');
  });

  it('links an untyped method call only when the name is unique in the project', () => {
    expect(text).toContain('call app::main -> app::extra::Z::only_here (low)');
    expect(text.filter((t) => t.startsWith('call app::main -> ') && t.endsWith('::reset (low)'))).toHaveLength(0);
  });

  it('does not link std calls', () => {
    expect(text.some((t) => t.includes('drop'))).toBe(false);
    expect(edges.every((e) => e.provenance === 'name_match')).toBe(true);
  });
});

describe('Rust name matching imports', () => {
  it('adds one import edge per use leaf, to the file defining the item behind re-exports', () => {
    const imports = text.filter((t) => t.startsWith('import '));
    expect(imports).toContain('import shop_core::order::service -> shop_core::order::repo (high)');
    expect(imports).toContain('import app -> shop_core::order::repo (high)');
    expect(imports).toContain('import app -> shop_core::order::service (high)');
    expect(imports).toContain('import shop_core -> shop_core::order::service (high)');
  });

  it('links `use super::*` to the parent module file', () => {
    expect(text).toContain('import shop_core::order -> shop_core (high)');
  });

  it('places import edges on the use leaf', () => {
    const svc = files.find((f) => f.path === 'core/src/order/service.rs')!;
    const lines = edges.filter((e) => e.kind === 'import' && e.srcId === svc.symbols[0]!.id).map((e) => [e.line, e.col]);
    expect(lines).toEqual([[1, 24], [2, 24]]);
  });
});
