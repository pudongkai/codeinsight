import { describe, expect, it } from 'vitest';
import { completeForResolve, extractGoFile, getGoParser } from '../src/index.js';
import { resolveChain } from '../src/extract/go-types.js';
import type { ExtractedFile, GoCallSite } from '../src/index.js';

const MODULES = new Map([['', 'example.com/m']]);
const P = 'example.com/m/p';
const NO_FLAGS = { isTest: false, isGenerated: false };

async function extract(source: string, file = 'p/a.go'): Promise<ExtractedFile> {
  return extractGoFile(await getGoParser(), file, source, NO_FLAGS, MODULES);
}

/** 方法调用名 → 推断出的接收者类型 */
function receivers(calls: GoCallSite[]): Record<string, string | undefined> {
  return Object.fromEntries(calls.filter((c) => c.form === 'selector').map((c) => [c.name, c.receiverType]));
}

const HEADER = 'package p\n\nimport "example.com/m/q"\n\ntype T struct {\n\tr Repo\n\tq *q.Q\n}\n\ntype Repo interface{ Find() }\n\nfunc NewT() *T { return nil }\n\n';

describe('go local type inference', () => {
  it('uses receiver and parameter declarations', async () => {
    const f = await extract(`${HEADER}func (t *T) A(x Repo, y *q.Q, n int) { t.Run(); x.Find(); y.Go(); n.Bad() }\n`);
    expect(receivers(f.go!.calls)).toEqual({ Run: `${P}.T`, Find: `${P}.Repo`, Go: 'example.com/m/q.Q', Bad: undefined });
  });

  it('uses var declarations, composite literals and constructors', async () => {
    const f = await extract(`${HEADER}func A() {\n\tvar a T\n\tb := &T{}\n\tc := T{}\n\td, err := NewT()\n\te := q.NewQ()\n\tf := d\n\ta.M1(); b.M2(); c.M3(); d.M4(); e.M5(); f.M6(); err.Error()\n}\n`);
    const r = receivers(f.go!.calls);
    expect(r).toMatchObject({ M1: `${P}.T`, M2: `${P}.T`, M3: `${P}.T`, M4: `${P}.T`, M6: `${P}.T`, Error: undefined });
    expect(r.M5).toBeUndefined();
    expect(f.go!.calls.find((c) => c.name === 'M5')!.receiverChain).toEqual({ root: { ctor: 'example.com/m/q.NewQ' }, fields: [] });
  });

  it('follows struct field types of the receiver', async () => {
    const f = await extract(`${HEADER}func (t T) A() { t.r.Find(); t.q.Go(); t.missing.X() }\n`);
    expect(receivers(f.go!.calls)).toEqual({ Find: `${P}.Repo`, Go: 'example.com/m/q.Q', X: undefined });
    expect(f.go!.calls.find((c) => c.name === 'X')!.receiverChain).toEqual({ root: { type: `${P}.T` }, fields: ['missing'] });
  });

  it('records function literal parameters and does not treat shadowed import names as packages', async () => {
    const f = await extract(`${HEADER}func A() {\n\th := func(x Repo) { x.Find() }\n\tq := NewT()\n\tq.Run()\n\th(nil)\n}\n`);
    const calls = f.go!.calls.map((c) => `${c.form}:${c.name}:${c.receiverType ?? ''}`);
    expect(calls).toEqual([`selector:Find:${P}.Repo`, 'ident:NewT:', `selector:Run:${P}.T`]);
  });

  it('treats range variables and type switch aliases that shadow import names as local variables', async () => {
    const src = [
      'package p', '', 'import (', '\t"example.com/m/order"', '\t"example.com/m/user"', ')', '',
      'func A(orders []order.Order, x any) {',
      '\tfor _, order := range orders {', '\t\torder.Save()', '\t}',
      '\tswitch user := x.(type) {', '\tcase int:', '\t\tuser.Load()', '\t}',
      '}', '',
    ].join('\n');
    const f = await extract(src);
    const calls = f.go!.calls.map((c) => `${c.form}:${c.name}:${c.qualifier ?? ''}`);
    expect(calls).toEqual(['selector:Save:', 'selector:Load:']);
  });

  it('restores import names after the range loop, type switch and function literal that shadowed them', async () => {
    const src = [
      'package p', '', 'import (', '\t"example.com/m/order"', '\t"example.com/m/user"', ')', '',
      'func A(orders []order.Order, x any) {',
      '\tfor _, order := range orders {', '\t\torder.Save()', '\t}',
      '\torder.X()',
      '\tswitch user := x.(type) {', '\tcase int:', '\t\tuser.Load()', '\t}',
      '\tuser.Load()',
      '\tf := func(order int) { order.In() }',
      '\torder.After()',
      '\tf(1)',
      '}', '',
    ].join('\n');
    const f = await extract(src);
    const calls = f.go!.calls.map((c) => `${c.form}:${c.name}:${c.qualifier ?? ''}`);
    expect(calls).toEqual([
      'selector:Save:', 'pkg:X:example.com/m/order', 'selector:Load:', 'pkg:Load:example.com/m/user',
      'selector:In:', 'pkg:After:example.com/m/order',
    ]);
  });

  it('fills cross-file constructor results and field types in cross-file processing', async () => {
    const q = await extract('package q\n\ntype Q struct{ inner *I }\n\ntype I struct{}\n\nfunc NewQ() (*Q, error) { return nil, nil }\n', 'q/q.go');
    const p = await extract(`${HEADER}func A(t *T) {\n\te, _ := q.NewQ()\n\te.Go()\n\tt.q.inner.Deep()\n}\n`);
    completeForResolve([q, p]);
    expect(receivers(p.go!.calls)).toEqual({ Go: 'example.com/m/q.Q', Deep: 'example.com/m/q.I' });
  });

  it('resolveChain stops when a step is unknown', () => {
    const lookup = { field: (t: string, f: string) => (t === 'a.T' && f === 'x' ? 'a.U' : undefined), funcResult: () => undefined };
    expect(resolveChain({ root: { type: 'a.T' }, fields: ['x'] }, lookup)).toBe('a.U');
    expect(resolveChain({ root: { type: 'a.T' }, fields: ['x', 'y'] }, lookup)).toBeUndefined();
    expect(resolveChain({ root: { ctor: 'a.New' }, fields: [] }, lookup)).toBeUndefined();
  });
});
