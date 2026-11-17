import { describe, expect, it } from 'vitest';
import { deserializeExtractedFile, serializeExtractedFile } from '../src/extract/cache.js';
import { collectRustEnvReads, collectRustPathRoots, extractRustFile, getRustParser, restoreRustFile, rustCratesFromManifests } from '../src/index.js';
import type { ExtractedFile, ExtractedSymbol } from '../src/index.js';

const NO_FLAGS = { isTest: false, isGenerated: false };

const CRATES = rustCratesFromManifests({
  manifests: new Map([['Cargo.toml', '[package]\nname = "shop-core"\nversion = "0.1.0"\n']]),
  files: ['Cargo.toml', 'src/lib.rs', 'src/order/repo.rs', 'tests/it.rs'],
});

async function extractOne(source: string, file = 'src/order/repo.rs', flags = NO_FLAGS): Promise<ExtractedFile> {
  return extractRustFile(await getRustParser(), file, source, flags, CRATES);
}

function byQn(f: ExtractedFile): Map<string, ExtractedSymbol> {
  return new Map(f.symbols.map((s) => [s.qualifiedName, s]));
}

const REPO = `//! Order storage.
//! Second line.

use crate::order::{self, service::Service as Svc};
pub use std::collections::*;

/// Storage for orders.
#[allow(unused)]
pub trait Repo {
    /// Looks up an order.
    fn find(&self, id: u64) -> Option<String>;

    fn exists(&self, id: u64) -> bool {
        self.find(id).is_some()
    }
}

#[derive(Default, serde::Serialize)]
#[diesel(table_name = repos)]
pub struct MemRepo {
    items: Vec<String>,
}

impl Repo for MemRepo {
    fn find(&self, id: u64) -> Option<String> {
        self.items.get(id as usize).cloned()
    }
}

pub(crate) enum Kind { A, B(u8) }

union Bits { a: u32 }

pub struct Foo(pub u32);

impl From< u8 > for Foo {
    fn from(v: u8) -> Self { Foo(v as u32) }
}

impl From<u16> for Foo {
    fn from(v: u16) -> Self { Foo(v as u32) }
}

impl<T: Clone> Repo for Vec<T> {
    fn find(&self, _id: u64) -> Option<String> { None }
}

impl Fn2 for &'static Foo where Foo: Sized {
    fn call(&self) {}
}

impl Foo {
    pub async fn r#type<'a>(&'a self, x: &'a str) -> &'a str where Self: Sized {
        fn inner(s: &str) -> &str { s }
        inner(x)
    }
}

mod helpers {
    pub fn util() {}
}

mod decl;

macro_rules! make { () => {} }

make! {
    fn hidden() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() {}

    #[tokio::test]
    async fn async_case() {}
}

#[test]
fn top_level_test() {}

fn plain() {
    let _p = std::env::var("APP_PORT");
    let _q = env!("BUILD_ENV");
    tracing::info!("x {}", serde_json::to_string(&1).unwrap());
}
`;

describe('Rust symbol extraction', () => {
  it('extracts the module, items, trait and impl methods with qualified names', async () => {
    const f = await extractOne(REPO);
    const qn = byQn(f);
    const mod = f.symbols[0]!;
    expect(mod).toMatchObject({ kind: 'module', name: 'repo', qualifiedName: 'shop_core::order::repo', docstring: 'Order storage.\nSecond line.' });
    const repo = qn.get('shop_core::order::repo::Repo')!;
    expect(repo).toMatchObject({ kind: 'interface', displaySignature: 'pub trait Repo', docstring: 'Storage for orders.', parentId: mod.id });
    expect(qn.get('shop_core::order::repo::Repo::find')).toMatchObject({
      kind: 'method', parentId: repo.id, displaySignature: 'fn find(&self, id: u64) -> Option<String>', docstring: 'Looks up an order.', normTokens: [],
    });
    expect(qn.get('shop_core::order::repo::Repo::exists')!.normTokens.length).toBeGreaterThan(0);
    const mem = qn.get('shop_core::order::repo::MemRepo')!;
    expect(mem).toMatchObject({ kind: 'class', displaySignature: 'pub struct MemRepo' });
    expect(qn.get('shop_core::order::repo::<MemRepo as Repo>::find')).toMatchObject({ kind: 'method', parentId: mem.id });
    expect(qn.get('shop_core::order::repo::Kind')).toMatchObject({ kind: 'class', displaySignature: 'pub(crate) enum Kind' });
    expect(qn.get('shop_core::order::repo::Bits')).toMatchObject({ kind: 'class' });
    expect(qn.get('shop_core::order::repo::helpers::util')).toMatchObject({ kind: 'function', parentId: mod.id });
  });

  it('keeps trait generic arguments so two From impls do not collide', async () => {
    const qn = byQn(await extractOne(REPO));
    const foo = qn.get('shop_core::order::repo::Foo')!;
    const u8 = qn.get('shop_core::order::repo::<Foo as From<u8>>::from')!;
    const u16 = qn.get('shop_core::order::repo::<Foo as From<u16>>::from')!;
    expect(u8.id).not.toBe(u16.id);
    expect(u8.parentId).toBe(foo.id);
    expect(qn.get('shop_core::order::repo::<Vec as Repo>::find')!.parentId).toBe(qn.get('shop_core::order::repo')!.id);
    expect(qn.get('shop_core::order::repo::<Foo as Fn2>::call')!.parentId).toBe(foo.id);
  });

  it('strips r# from raw identifiers and extracts functions nested in function bodies', async () => {
    const qn = byQn(await extractOne(REPO));
    const ty = qn.get('shop_core::order::repo::Foo::type')!;
    expect(ty).toMatchObject({ name: 'type', displaySignature: "pub async fn r#type<'a>(&'a self, x: &'a str) -> &'a str where Self: Sized" });
    expect(qn.get('shop_core::order::repo::Foo::type::inner')).toMatchObject({ kind: 'function', parentId: ty.id });
  });

  it('does not extract items written inside macro invocations', async () => {
    const f = await extractOne(REPO);
    expect(f.symbols.some((s) => s.name === 'hidden' || s.name === 'make')).toBe(false);
    const lines = REPO.split('\n');
    const start = lines.findIndex((l) => l.startsWith('make!'));
    expect(f.rust!.macroRanges).toEqual([[start, start + 2]]);
  });

  it('marks symbols in cfg(test) modules and with test attributes as tests', async () => {
    const qn = byQn(await extractOne(REPO));
    expect(qn.get('shop_core::order::repo::tests::fixture')!.isTest).toBe(true);
    expect(qn.get('shop_core::order::repo::tests::async_case')!.isTest).toBe(true);
    expect(qn.get('shop_core::order::repo::top_level_test')!.isTest).toBe(true);
    expect(qn.get('shop_core::order::repo::plain')!.isTest).toBe(false);
    const testFile = await extractOne('fn helper() {}\n', 'tests/it.rs', { isTest: true, isGenerated: false });
    expect(testFile.symbols.every((s) => s.isTest)).toBe(true);
    expect(testFile.symbols[0]!.qualifiedName).toBe('it');
  });

  it('hashes the item text with its attributes', async () => {
    const a = byQn(await extractOne(REPO)).get('shop_core::order::repo::MemRepo')!;
    const b = byQn(await extractOne(REPO.replace('#[derive(Default, serde::Serialize)]', '#[derive(Default)]'))).get('shop_core::order::repo::MemRepo')!;
    expect(a.bodyHash).not.toBe(b.bodyHash);
    expect(a.startLine).toBe(b.startLine);
  });

  it('records name positions for SCIP matching', async () => {
    const f = await extractOne(REPO);
    const find = byQn(f).get('shop_core::order::repo::Repo::find')!;
    const line = REPO.split('\n')[find.nameLine]!;
    expect(line.slice(find.nameCol, find.nameCol + 4)).toBe('find');
  });
});

describe('Rust extraction edge cases', () => {
  it('names impl blocks on trait objects after the trait', async () => {
    const qn = byQn(await extractOne(`pub trait Repo<T> {}
impl dyn Repo<u8> + Send { fn boxed(&self) {} }
impl fmt::Debug for dyn Repo<u8> { fn fmt(&self) {} }
impl<'a> Clone for &'a dyn Repo<u8> { fn clone(&self) -> Self { *self } }
`));
    expect(qn.has('shop_core::order::repo::Repo::boxed')).toBe(true);
    expect(qn.has('shop_core::order::repo::<Repo as fmt::Debug>::fmt')).toBe(true);
    expect(qn.has('shop_core::order::repo::<Repo as Clone>::clone')).toBe(true);
  });

  it('does not treat methods of impl, trait or mod blocks inside a function body as nested functions', async () => {
    const f = await extractOne(`fn outer() {
    struct Local;
    impl std::fmt::Display for Local { fn fmt(&self) {} }
    impl Local { fn fmt(&self) {} }
    trait T { fn m(&self) {} }
    mod m { pub fn inside() {} }
    fn helper() {}
}
`);
    expect(f.symbols.filter((s) => s.kind !== 'module').map((s) => s.qualifiedName)).toEqual([
      'shop_core::order::repo::outer', 'shop_core::order::repo::outer::helper',
    ]);
  });

  it('reads cfg(test) only from the cfg predicate itself', async () => {
    const f = await extractOne(`#[cfg(feature = "test-utils")]
mod utils { pub fn a() {} }
#[cfg(any(test, not(unix)))]
mod either { pub fn b() {} }
#[cfg(not(test))]
mod prod { pub fn c() {} }
#[cfg(all(test, feature = "x"))]
mod both { pub fn d() {} }
`);
    const test = (name: string) => f.symbols.find((s) => s.name === name)!.isTest;
    expect([test('a'), test('b'), test('c'), test('d')]).toEqual([false, true, false, true]);
  });
});

describe('Rust file facts', () => {
  it('records use leaves, use rows, mod declarations and derives', async () => {
    const f = await extractOne(REPO);
    const lines = REPO.split('\n');
    const at = (p: { line: number; col: number }) => lines[p.line]!.slice(p.col).match(/^\w+/)![0];
    expect(f.rust!.useLeaves.map(at)).toEqual(['self', 'Service', 'collections', 'super']);
    const superRow = lines.indexOf('    use super::*;');
    expect(f.importRows).toEqual([[3, 3], [4, 4], [superRow, superRow]]);
    expect(f.rust!.modDecls).toEqual([lines.indexOf('mod decl;')]);
    const mem = byQn(f).get('shop_core::order::repo::MemRepo')!;
    expect(f.rust!.derives[mem.id]).toEqual({ derives: ['Default', 'Serialize'], attrs: ['diesel'] });
    expect(f.rust).toMatchObject({ crate: 'shop_core', target: 'src/lib.rs', modulePath: ['order', 'repo'] });
  });

  it('collects first path segments from paths, macros, attributes and uses', async () => {
    const parser = await getRustParser();
    const tree = parser.parse(REPO)!;
    expect(collectRustPathRoots(tree.rootNode)).toEqual(['crate', 'serde', 'serde_json', 'std', 'super', 'tokio', 'tracing']);
    tree.delete();
  });

  it('collects literal environment variable names', async () => {
    const parser = await getRustParser();
    const src = `use std::env;
use std::env::var as get;
fn a() {
    env::var("A").ok();
    get("B").ok();
    std::env::var_os("C");
    dotenvy::var("D").ok();
    option_env!("E");
    other::var("F");
    env::var(name);
}
`;
    const tree = parser.parse(src)!;
    expect(collectRustEnvReads(tree.rootNode)).toEqual(['A', 'B', 'C', 'D', 'E']);
    tree.delete();
  });

  it('collects environment variable reads written inside other macro arguments', async () => {
    const parser = await getRustParser();
    const src = `use std::env;
fn a() {
    println!("{}", std::env::var("B").unwrap());
    tracing::info!(port = %env::var("C").unwrap_or_default());
    format!("{:?}", vec![dotenvy::var("D")]);
    println!("{}", other::var("F"));
    println!("{}", env!("G"));
    let _ = concat!(std::option_env!("H"), "x");
    println!("{}", not_env!("I"));
}
include!(concat!(env!("OUT_DIR"), "/x.rs"));
`;
    const tree = parser.parse(src)!;
    expect(collectRustEnvReads(tree.rootNode)).toEqual(['B', 'C', 'D', 'G', 'H', 'OUT_DIR']);
    tree.delete();
  });

  it('takes the type name as the first segment of paths with generic arguments', async () => {
    const parser = await getRustParser();
    const tree = parser.parse('fn a() { Vec::<u8>::new(); reqwest::Client::<X>::new(); }\n')!;
    expect(collectRustPathRoots(tree.rootNode)).toEqual(['Vec', 'reqwest']);
    tree.delete();
  });

  it('records item-level macro calls ending with a semicolon', async () => {
    const f = await extractOne('thread_local!(static X: u8 = 1);\nfn a() { println!("x"); }\nmacro_rules_like! { fn hidden() {} }\n');
    expect(f.rust!.macroRanges).toEqual([[0, 0], [2, 2]]);
  });

  it('round-trips through the extract cache and restores from stored rows', async () => {
    const f = await extractOne(REPO);
    expect(deserializeExtractedFile(serializeExtractedFile(f)).rust).toEqual(f.rust);
    const rows = f.symbols.map(({ nameLine: _l, nameCol: _c, ...s }) => s);
    const restored = restoreRustFile(await getRustParser(), f.path, REPO, rows, CRATES);
    expect(restored.rust).toEqual(f.rust);
    expect(restored.symbols.map((s) => `${s.id}@${s.nameLine}:${s.nameCol}`)).toEqual(f.symbols.map((s) => `${s.id}@${s.nameLine}:${s.nameCol}`));
  });
});
