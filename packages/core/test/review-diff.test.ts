import { describe, expect, it } from 'vitest';
import { bodySimilarity, diffSymbols, makeSymbolKey, moduleOf, pathSimilarity, Store, symbolIdFromKey, traverse } from '../src/index.js';
import type { EdgeRow, SymbolRow } from '../src/index.js';
import path from 'node:path';
import { tempDir } from './helpers/git-repo.js';

function sym(p: string, qualifiedName: string, bodyHash: string, extra: Partial<SymbolRow> = {}): SymbolRow {
  const kind = extra.kind ?? 'function';
  const key = makeSymbolKey({ path: p, kind, qualifiedName, signature: '' });
  return {
    snapshotId: 1, id: symbolIdFromKey(key), symbolKey: key, kind, name: qualifiedName.split('.').pop()!, qualifiedName,
    signature: '', displaySignature: '()', parentId: null, path: p, startLine: 1, endLine: 2, bodyHash,
    normTokens: [], docstring: null, isTest: false, isGenerated: false, ...extra,
  };
}

const TOKENS = 'return ID ( ID , ID ) + ID . ID ( NUM ) - ID [ NUM ] * ID ( ID , ID , ID ) + ID . ID ( ) - ID'.split(' ');

describe('diffSymbols', () => {
  it('pairs moved functions by body similarity when the hash differs, and leaves dissimilar ones as added / removed', () => {
    const near = [...TOKENS.slice(0, -1), 'NUM'];
    const base = [sym('a.py', 'f', 'h1'), sym('a.py', 'g', 'h2')];
    const head = [sym('b.py', 'f', 'h1x'), sym('b.py', 'g', 'h2x')];
    const tokens = new Map([[base[0]!.id, TOKENS], [head[0]!.id, near], [base[1]!.id, TOKENS], [head[1]!.id, ['pass']]]);
    expect(bodySimilarity(TOKENS, near)).toBeGreaterThanOrEqual(0.9);
    const diffs = diffSymbols({ base, head, loadTokens: (_side, ids) => new Map(ids.map((id) => [id, tokens.get(id) ?? []])) });
    expect(diffs.map((d) => `${d.change} ${(d.head ?? d.base)!.symbolKey}`).sort()).toEqual([
      'added b.py#function#g#', 'moved b.py#function#f#', 'removed a.py#function#g#',
    ]);
  });

  it('prefers the identical body over path similarity when two same-name functions move together', () => {
    const base = [sym('pkg/x/one.py', 'helper', 'A'), sym('pkg/y/two.py', 'helper', 'B')];
    // 路径上 one.py 更像 x/three.py，但函数体 A 去了 y/four.py
    const head = [sym('pkg/x/three.py', 'helper', 'B'), sym('pkg/y/four.py', 'helper', 'A')];
    const diffs = diffSymbols({ base, head, loadTokens: () => new Map() });
    const pairs = diffs.map((d) => `${d.change} ${d.base?.path} -> ${d.head?.path}`).sort();
    expect(pairs).toEqual(['moved pkg/x/one.py -> pkg/y/four.py', 'moved pkg/y/two.py -> pkg/x/three.py']);
  });

  it('uses path similarity to break ties between identical bodies', () => {
    const base = [sym('svc/a/repo.py', 'insert', 'S'), sym('svc/b/repo.py', 'insert', 'S')];
    const head = [sym('core/b/repo.py', 'insert', 'S'), sym('core/a/repo.py', 'insert', 'S')];
    const diffs = diffSymbols({ base, head, loadTokens: () => new Map() });
    expect(diffs.map((d) => `${d.base?.path} -> ${d.head?.path}`).sort()).toEqual(['svc/a/repo.py -> core/a/repo.py', 'svc/b/repo.py -> core/b/repo.py']);
  });

  it('does not pair different kinds', () => {
    const diffs = diffSymbols({ base: [sym('a.py', 'C', 'h', { kind: 'class' })], head: [sym('b.py', 'C', 'h')], loadTokens: () => new Map() });
    expect(diffs.map((d) => d.change).sort()).toEqual(['added', 'removed']);
  });

  it('keeps duplicate definitions aligned when one of them is deleted or inserted', () => {
    const dup = (qn: string, hash: string, line: number) => sym('a.py', qn, hash, { name: 'dup', startLine: line });
    const describe = (ds: ReturnType<typeof diffSymbols>) => ds.map((d) => `${d.change} ${(d.base ?? d.head)!.bodyHash}`);
    expect(describe(diffSymbols({ base: [dup('dup', 'A', 1), dup('dup#2', 'B', 5)], head: [dup('dup', 'B', 1)], loadTokens: () => new Map() })))
      .toEqual(['removed A']);
    expect(describe(diffSymbols({ base: [dup('dup', 'A', 1)], head: [dup('dup', 'C', 1), dup('dup#2', 'A', 5)], loadTokens: () => new Map() })))
      .toEqual(['added C']);
    expect(describe(diffSymbols({ base: [dup('dup', 'A', 1), dup('dup#2', 'B', 5)], head: [dup('dup', 'A', 1), dup('dup#2', 'B2', 5)], loadTokens: () => new Map() })))
      .toEqual(['modified B']);
  });

  it('pairs a thousand moved __init__ methods one to one in reasonable time', () => {
    const n = 1000;
    const base: SymbolRow[] = [];
    const head: SymbolRow[] = [];
    const tokens = new Map<string, string[]>();
    for (let i = 0; i < n; i++) {
      const b = sym(`old/m${i}.py`, `C${i}.__init__`, `h${i}`, { kind: 'method', name: '__init__' });
      // 偶数下标函数体原样搬走，奇数下标搬家时改了最后一个 token
      const h = sym(`new/m${i}.py`, `C${i}.__init__`, i % 2 === 0 ? `h${i}` : `h${i}x`, { kind: 'method', name: '__init__' });
      const body = Array.from({ length: 40 }, (_, j) => `t${i}_${j}`);
      tokens.set(b.id, body);
      tokens.set(h.id, [...body.slice(0, -1), 'changed']);
      base.push(b);
      head.push(h);
    }
    const started = Date.now();
    const diffs = diffSymbols({ base, head, loadTokens: (_side, ids) => new Map(ids.map((id) => [id, tokens.get(id) ?? []])) });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(diffs).toHaveLength(n);
    for (const d of diffs) {
      expect(d.change).toBe('moved');
      expect(d.head!.qualifiedName).toBe(d.base!.qualifiedName);
    }
  });

  it('computes path similarity and module names', () => {
    expect(pathSimilarity('server/app/x/y.py', 'server/x/y.py')).toBe(0.75);
    expect(moduleOf('server/console/modules/console/admin_api.py', 3)).toBe('server/console/modules');
    expect(moduleOf('setup.py', 3)).toBe('.');
  });
});

describe('graph traverse', () => {
  function edge(src: SymbolRow, dst: SymbolRow, kind: EdgeRow['kind'] = 'call'): EdgeRow {
    return { snapshotId: 0, srcId: src.id, dstId: dst.id, kind, provenance: 'scip', confidence: 'high', path: src.path, line: 1, col: 0 };
  }

  it('walks callers and callees by layer for several origins, optionally hiding test code', () => {
    const store = new Store(path.join(tempDir('ci-graph-'), 'index.db'));
    const snap = store.createSnapshot('commit', 'x', 'x');
    const [t, a, b, c, d] = [sym('t.py', 't', ''), sym('a.py', 'a', ''), sym('b.py', 'b', ''), sym('c.py', 'c', ''), sym('tests/test_d.py', 'd', '', { isTest: true })];
    const all = [t, a, b, c, d].map((s) => ({ ...s, snapshotId: snap.id }));
    store.insertSymbols(all);
    // c -> b -> a -> t，d(test) -> a，a -> a（递归），c 引用 t
    store.insertEdges([edge(b, a), edge(c, b), edge(a, t), edge(d, a), edge(a, a), edge(c, t, 'reference'), edge(c, b)].map((e) => ({ ...e, snapshotId: snap.id })));

    const up = traverse(store, snap.id, [t.id, a.id], { direction: 'callers', depth: 2 });
    expect(Object.fromEntries(up.reached.get(t.id)!)).toEqual({ [a.id]: 1, [c.id]: 1, [b.id]: 2, [d.id]: 2 });
    expect(Object.fromEntries(up.reached.get(a.id)!)).toEqual({ [b.id]: 1, [d.id]: 1, [c.id]: 2 });

    const prodOnly = traverse(store, snap.id, [a.id], { direction: 'callers', depth: 3, edgeKinds: ['call'], includeTests: false });
    expect([...prodOnly.reached.get(a.id)!.keys()].sort()).toEqual([b.id, c.id].sort());

    const down = traverse(store, snap.id, [c.id], { direction: 'callees', depth: 1 });
    expect([...down.reached.get(c.id)!.keys()].sort()).toEqual([b.id, t.id].sort());
    expect(down.edges.filter((e) => e.dstId === b.id)).toHaveLength(2);
    store.close();
  });
});
