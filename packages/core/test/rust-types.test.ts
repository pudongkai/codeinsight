import { describe, expect, it } from 'vitest';
import { extractRustFile, getRustParser, rustCratesFromManifests } from '../src/index.js';
import type { ExtractedFile, RustCallSite } from '../src/index.js';

const NO_FLAGS = { isTest: false, isGenerated: false };

const CRATES = rustCratesFromManifests({
  manifests: new Map([['Cargo.toml', '[package]\nname = "shop-core"\nversion = "0.1.0"\n']]),
  files: ['Cargo.toml', 'src/lib.rs', 'src/order/service.rs'],
});

async function extract(source: string, file = 'src/order/service.rs'): Promise<ExtractedFile> {
  return extractRustFile(await getRustParser(), file, source, NO_FLAGS, CRATES);
}

function idOf(f: ExtractedFile, qn: string): string {
  const s = f.symbols.find((x) => x.qualifiedName === qn);
  if (!s) throw new Error(`no symbol ${qn}`);
  return s.id;
}

function callsIn(f: ExtractedFile, qn: string): RustCallSite[] {
  const id = idOf(f, qn);
  return f.rust!.calls.filter((c) => c.callerId === id);
}

const SERVICE = `use crate::order::repo::{Repo, MemRepo as Mem};
use super::helpers::*;
pub use self::inner::Thing;
use std::sync::Arc;

pub struct Service<R: Repo> {
    repo: R,
    shared: Arc<Mem>,
    count: u32,
    other: Box<dyn Repo>,
}

impl<R> Service<R> where R: Repo {
    pub fn new(repo: R) -> Self {
        Service { repo, shared: Arc::new(Mem::default()), count: 0, other: Box::new(Mem::default()) }
    }

    pub fn create(&self, id: u64) -> Option<String> {
        let parsed = "7".parse::<u64>().ok()?;
        let local: &Mem = &self.shared;
        local.find(id);
        Self::helper();
        self.repo.find(id + parsed)
    }

    fn helper() {}
}

pub fn run(r: impl Repo, d: &dyn Repo) {
    let svc = Service::new(Mem::default());
    let lit = Service { repo: Mem::default(), shared: todo(), count: 1, other: todo() };
    svc.create(1);
    lit.repo.find(2);
    r.find(3);
    d.find(4);
    Vec::<u8>::new();
    crate::order::repo::build::<u8>();
    super::top();
    let f = |x: u8| x;
    f(1);
    for svc in [1] { svc.create(5); }
    format!("{}", make());
}

mod inner {
    pub struct Thing;
    pub fn go() {
        super::run_inner();
        local();
    }
}
`;

describe('Rust use bindings', () => {
  it('expands use trees into canonical paths, globs and pub re-exports', async () => {
    const f = await extract(SERVICE);
    expect(f.rust!.uses).toMatchObject({
      Repo: ['crate', 'order', 'repo', 'Repo'],
      Mem: ['crate', 'order', 'repo', 'MemRepo'],
      Thing: ['crate', 'order', 'service', 'inner', 'Thing'],
      Arc: ['std', 'sync', 'Arc'],
    });
    expect(f.rust!.globUses).toEqual([['crate', 'order', 'helpers']]);
    expect(f.rust!.pubUses).toEqual({ Thing: ['crate', 'order', 'service', 'inner', 'Thing'] });
  });

  it('resolves super inside an inline mod relative to that mod', async () => {
    const f = await extract('mod tests {\n    use super::*;\n    use super::super::Top;\n}\n');
    expect(f.rust!.modUses?.tests?.globUses).toEqual([['crate', 'order', 'service']]);
    expect(f.rust!.modUses?.tests?.uses.Top).toEqual(['crate', 'order', 'Top']);
  });

  it('keeps inline mod and function body uses out of the file-level bindings', async () => {
    const f = await extract([
      'use crate::a::Top;',
      'mod tests { use crate::config::load as run2; use crate::b::Top; }',
      'fn f() { use crate::c::helper; helper(); inner(); fn inner() { helper(); } }',
      'fn g() { helper(); run2(); }',
      'fn h() { mod tests { use crate::d::Other; } }',
    ].join('\n'));
    expect(f.rust!.uses).toEqual({ Top: ['crate', 'a', 'Top'] });
    expect(f.rust!.modUses?.tests?.uses).toEqual({ run2: ['crate', 'config', 'load'], Top: ['crate', 'b', 'Top'] });
    const segs = (qn: string): string[] => callsIn(f, qn).map((c) => c.segments.join('::'));
    expect(segs('shop_core::order::service::f')).toEqual(['crate::c::helper', 'inner']);
    expect(segs('shop_core::order::service::f::inner')).toEqual(['crate::c::helper']);
    expect(segs('shop_core::order::service::g')).toEqual(['helper', 'run2']);
  });
});

describe('Rust call sites', () => {
  it('does not treat names in a match guard as bindings', async () => {
    const f = await extract('fn m(x: Option<u8>) {\n    match x { Some(v) if check(v) => {}, _ => {} }\n    check(1);\n}\n');
    expect(callsIn(f, 'shop_core::order::service::m').map((c) => c.segments.join('::'))).toEqual(['check', 'check']);
  });

  it('shadows pattern variables only inside the closure, loop, match arm or if let that binds them', async () => {
    const f = await extract(`struct Thing;
fn m(xs: Vec<u8>, o: Option<u8>) {
    let t = Thing::new();
    xs.iter().map(|t| t.a());
    for t in [1] { t.b(); }
    match o { Some(t) => t.c(), None => {} }
    if let Some(t) = o { t.d(); }
    t.run();
}
`);
    const methods = callsIn(f, 'shop_core::order::service::m').filter((c) => c.form === 'method');
    const chain = (name: string) => methods.find((c) => c.segments[0] === name)?.receiverChain;
    for (const inner of ['a', 'b', 'c', 'd']) expect(chain(inner)).toBeUndefined();
    expect(chain('run')).toEqual({ root: { call: ['Thing', 'new'] }, fields: [] });
  });

  it('records path calls with turbofish removed and Self replaced', async () => {
    const f = await extract(SERVICE);
    const paths = callsIn(f, 'shop_core::order::service::run').filter((c) => c.form === 'path').map((c) => c.segments.join('::'));
    expect(paths).toEqual(expect.arrayContaining([
      'Service::new', 'Mem::default', 'Vec::new', 'crate::order::repo::build', 'crate::order::top',
    ]));
    expect(paths).not.toContain('f');
    const create = callsIn(f, 'shop_core::order::service::Service::create');
    expect(create.find((c) => c.form === 'path')).toMatchObject({ segments: ['Service', 'helper'] });
  });

  it('records the position of the called name', async () => {
    const f = await extract(SERVICE);
    const helper = callsIn(f, 'shop_core::order::service::Service::create').find((c) => c.segments.join('::') === 'Service::helper')!;
    const line = SERVICE.split('\n')[helper.line]!;
    expect(line.slice(helper.col, helper.col + 'helper'.length)).toBe('helper');
  });

  it('infers receiver chains from self fields, params, let bindings and constructors', async () => {
    const f = await extract(SERVICE);
    const create = callsIn(f, 'shop_core::order::service::Service::create').filter((c) => c.form === 'method');
    expect(create.find((c) => c.line === 20)?.receiverChain).toEqual({ root: { type: ['Mem'] }, fields: [] });
    expect(create.find((c) => c.segments[0] === 'find' && c.line === 22)?.receiverChain).toEqual({ root: { type: ['Service'] }, fields: ['repo'] });
    const run = callsIn(f, 'shop_core::order::service::run').filter((c) => c.form === 'method');
    const chainAt = (line: number) => run.find((c) => c.line === line)?.receiverChain;
    expect(chainAt(31)).toEqual({ root: { call: ['Service', 'new'] }, fields: [] });
    expect(chainAt(32)).toEqual({ root: { type: ['Service'] }, fields: ['repo'] });
    expect(chainAt(33)).toEqual({ root: { type: ['Repo'] }, fields: [] });
    expect(chainAt(34)).toEqual({ root: { type: ['Repo'] }, fields: [] });
    expect(chainAt(40)).toBeUndefined();
  });

  it('does not look inside macros and records calls of inline mods with their mod', async () => {
    const f = await extract(SERVICE);
    expect(f.rust!.calls.some((c) => c.segments[0] === 'make')).toBe(false);
    const go = callsIn(f, 'shop_core::order::service::inner::go');
    expect(go.map((c) => [c.segments.join('::'), c.mod])).toEqual([
      ['crate::order::service::run_inner', ['inner']],
      ['local', ['inner']],
    ]);
  });
});

describe('Rust type facts', () => {
  it('records struct field types through generic bounds and wrappers', async () => {
    const f = await extract(SERVICE);
    expect(f.rust!.structFields[idOf(f, 'shop_core::order::service::Service')]).toEqual({
      repo: { segments: ['Repo'] }, shared: { segments: ['Mem'] }, other: { segments: ['Repo'] },
    });
  });

  it('records function results with Self replaced and impl target types', async () => {
    const f = await extract(SERVICE);
    const newId = idOf(f, 'shop_core::order::service::Service::new');
    expect(f.rust!.fnResults[newId]).toEqual({ segments: ['Service'] });
    expect(f.rust!.fnResults[idOf(f, 'shop_core::order::service::Service::create')]).toEqual({ segments: ['String'] });
    expect(f.rust!.implTypes[newId]).toEqual({ segments: ['Service'] });
  });

  it('uses the trait as Self inside trait default methods', async () => {
    const f = await extract('pub trait Repo {\n    fn find(&self) -> Option<u8>;\n    fn exists(&self) -> bool { self.find().is_some() }\n}\n');
    const call = f.rust!.calls.find((c) => c.segments[0] === 'find')!;
    expect(call.receiverChain).toEqual({ root: { type: ['crate', 'order', 'service', 'Repo'] }, fields: [] });
  });
});
