import path from 'node:path';
import { makeSymbolKey, Store, symbolIdFromKey } from '@codeinsight/core';
import type { SymbolRow } from '@codeinsight/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lookupSymbol } from '../src/mcp/lookup.js';
import { tempDir } from './helpers/env.js';

function row(snapshotId: number, p: string, kind: string, name: string, qualifiedName: string): SymbolRow {
  const symbolKey = makeSymbolKey({ path: p, kind, qualifiedName, signature: '' });
  return {
    snapshotId, id: symbolIdFromKey(symbolKey), symbolKey, kind, name, qualifiedName, signature: '', displaySignature: '',
    parentId: null, path: p, startLine: 1, endLine: 3, bodyHash: '', normTokens: [], docstring: null, isTest: false, isGenerated: false, modelKind: null,
  };
}

describe('lookupSymbol', () => {
  let store: Store;
  let snap: number;
  beforeAll(() => {
    store = new Store(path.join(tempDir('ci-mcp-lookup-'), 'index.db'));
    snap = store.createSnapshot('commit', 'x', 'x').id;
    store.insertSymbols([
      row(snap, 'pkg/service.py', 'method', 'run', 'pkg.service.Service.run'),
      row(snap, 'pkg/other.py', 'function', 'run', 'pkg.other.run'),
      row(snap, 'crates/core/src/order/service.rs', 'method', 'create', 'shop_core::order::service::Service::create'),
      row(snap, 'crates/core/src/order/other.rs', 'method', 'create', 'shop_core::order::other::Other::create'),
      row(snap, 'crates/core/src/order/repo.rs', 'method', 'from', 'shop_core::order::repo::<Foo as From<u8>>::from'),
      row(snap, 'crates/core/src/order/repo.rs', 'method', 'from', 'shop_core::order::repo::<Foo as From<u16>>::from'),
      row(snap, 'crates/app/src/main.rs', 'function', 'closure1', 'app::main::closure1'),
      row(snap, 'crates/app/src/bin/tool.rs', 'function', 'closure1', 'tool::main::closure1'),
      row(snap, 'crates/app/src/dup.rs', 'function', 'twice', 'app::dup::twice'),
      row(snap, 'crates/app/src/dup.rs', 'function', 'twice', 'app::dup::twice#2'),
    ]);
  });
  afterAll(() => store.close());

  const found = (q: string) => {
    const r = lookupSymbol(store, snap, q);
    return r.kind === 'found' ? r.symbol.qualifiedName : r.kind === 'ambiguous' ? r.candidates.map((c) => c.qualifiedName) : undefined;
  };

  it('finds Rust symbols by a `::` qualified name, including trait impl methods and closures', () => {
    expect(found('shop_core::order::service::Service::create')).toBe('shop_core::order::service::Service::create');
    expect(found('shop_core::order::repo::<Foo as From<u16>>::from')).toBe('shop_core::order::repo::<Foo as From<u16>>::from');
    expect(found('tool::main::closure1')).toBe('tool::main::closure1');
    expect(found('shop_core::order::service::Service::missing')).toBeUndefined();
  });

  it('returns candidates for a bare Rust name and both definitions for a deduplicated qualified name', () => {
    expect(found('create')).toEqual(['shop_core::order::other::Other::create', 'shop_core::order::service::Service::create']);
    expect(found('app::dup::twice')).toEqual(['app::dup::twice', 'app::dup::twice#2']);
  });

  it('treats a leading `crate::` as any crate name and falls back to `::` suffix matching', () => {
    expect(found('crate::order::service::Service::create')).toBe('shop_core::order::service::Service::create');
    expect(found('crate::service::Service::create')).toBeUndefined();
    expect(found('Service::create')).toBe('shop_core::order::service::Service::create');
    expect(found('main::closure1')).toEqual(['tool::main::closure1', 'app::main::closure1']);
    expect(found('<Foo as From<u8>>::from')).toBe('shop_core::order::repo::<Foo as From<u8>>::from');
    expect(found('rvice::Service::create')).toBeUndefined();
  });

  it('prefers an exact `::` match over suffix matches', () => {
    expect(found('app::dup::twice')).toEqual(['app::dup::twice', 'app::dup::twice#2']);
  });

  it('keeps `.` qualified names and symbol keys working', () => {
    expect(found('pkg.other.run')).toBe('pkg.other.run');
    expect(found('pkg/service.py#method#pkg.service.Service.run#')).toBe('pkg.service.Service.run');
    expect(found('crates/app/src/dup.rs#function#app::dup::twice#2#')).toBe('app::dup::twice#2');
  });
});
