import { beforeAll, describe, expect, it } from 'vitest';
import { completeGoFiles } from '../src/extract/go-index.js';
import { extractGoFile, getGoParser } from '../src/index.js';
import type { EdgeRow, ExtractedFile } from '../src/index.js';
import { goNameMatchEdges } from '../src/resolve/go-name-match.js';

const MODULES = new Map([['', 'example.com/m']]);
const NO_FLAGS = { isTest: false, isGenerated: false };

const SOURCES: Record<string, string> = {
  'a/a.go': `package a

import (
	"fmt"

	"example.com/m/b"
)

type Svc struct {
	repo b.Repo
}

func helper() {}

func (s *Svc) Run() {
	helper()
	t := b.NewThing()
	t.Do()
	s.repo.Find()
	x := unknown()
	x.Unique()
	x.Close()
	fmt.Println("done")
}
`,
  'b/a.go': `package b

type Thing struct{}

func NewThing() *Thing { return &Thing{} }

func (t *Thing) Do() {}

func (t *Thing) Unique() {}

func (t *Thing) Close() {}

type Repo interface {
	Find()
}
`,
  'b/doc.go': `// Package b holds things.
package b

type Other struct{}

func (o Other) Close() {}
`,
};

describe('go name matching', () => {
  let files: ExtractedFile[];
  let edges: EdgeRow[];
  const qn = (id: string): string => files.flatMap((f) => f.symbols).find((s) => s.id === id)!.qualifiedName;
  const calls = (): string[] => edges.filter((e) => e.kind === 'call').map((e) => `${qn(e.srcId)} -> ${qn(e.dstId)} ${e.confidence}`);

  beforeAll(async () => {
    const parser = await getGoParser();
    files = Object.entries(SOURCES).map(([p, src]) => extractGoFile(parser, p, src, NO_FLAGS, MODULES));
    completeGoFiles(files);
    edges = goNameMatchEdges(files, 7, new Map(Object.entries(SOURCES)));
  });

  it('links an identifier call to the function in the same package', () => {
    expect(calls()).toContain('example.com/m/a.Svc.Run -> example.com/m/a.helper high');
  });

  it('links a package-qualified call to the function in that project package', () => {
    expect(calls()).toContain('example.com/m/a.Svc.Run -> example.com/m/b.NewThing high');
  });

  it('links a selector call by the inferred receiver type', () => {
    expect(calls()).toContain('example.com/m/a.Svc.Run -> example.com/m/b.Thing.Do high');
  });

  it('links a call through an interface field to the interface method', () => {
    expect(calls()).toContain('example.com/m/a.Svc.Run -> example.com/m/b.Repo.Find high');
  });

  it('links an untyped selector call only when the method name is unique, with low confidence', () => {
    expect(calls()).toContain('example.com/m/a.Svc.Run -> example.com/m/b.Thing.Unique low');
    expect(calls().some((c) => c.includes('.Close'))).toBe(false);
  });

  it('emits no edges to external packages and only call/import edges with name_match provenance', () => {
    expect(calls()).toHaveLength(5);
    expect(edges.every((e) => e.provenance === 'name_match' && e.snapshotId === 7)).toBe(true);
  });

  it('adds an import edge from the file module to the representative file of the imported package', () => {
    const imports = edges.filter((e) => e.kind === 'import');
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({ path: 'a/a.go', line: 6, srcId: files[0]!.symbols[0]!.id, dstId: files[2]!.symbols[0]!.id });
  });
});

describe('go name matching with an external test package', () => {
  const sources: Record<string, string> = {
    'b/a.go': SOURCES['b/a.go']!,
    'b/a_test.go': `package b_test

import (
	"testing"

	"example.com/m/b"
)

func setup() {}

func TestThing(t *testing.T) {
	setup()
	b.NewThing()
	NewThing()
}
`,
    'b/b_test.go': `package b

func TestInternal() {
	setup()
	NewThing()
}
`,
  };

  it('keeps identifier calls inside their own package and links the import of the package under test', async () => {
    const parser = await getGoParser();
    const files = Object.entries(sources).map(([p, src]) => extractGoFile(parser, p, src, NO_FLAGS, MODULES));
    completeGoFiles(files);
    const edges = goNameMatchEdges(files, 1, new Map(Object.entries(sources)));
    const qn = (id: string): string => files.flatMap((f) => f.symbols).find((s) => s.id === id)!.qualifiedName;
    const calls = edges.filter((e) => e.kind === 'call').map((e) => `${e.path}: ${qn(e.srcId)} -> ${qn(e.dstId)}`);
    expect(calls.sort()).toEqual([
      'b/a_test.go: example.com/m/b.TestThing -> example.com/m/b.NewThing',
      'b/a_test.go: example.com/m/b.TestThing -> example.com/m/b.setup',
      'b/b_test.go: example.com/m/b.TestInternal -> example.com/m/b.NewThing',
    ]);
    const imports = edges.filter((e) => e.kind === 'import');
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({ path: 'b/a_test.go', line: 6, dstId: files[0]!.symbols[0]!.id });
  });
  it('links a method call on a value returned by the package under test from the external test package', async () => {
    const src: Record<string, string> = {
      'b/a.go': SOURCES['b/a.go']!,
      'b/c_test.go': `package b_test

import "example.com/m/b"

func TestDo() {
	t := b.NewThing()
	t.Do()
}
`,
    };
    const parser = await getGoParser();
    const files = Object.entries(src).map(([p, s]) => extractGoFile(parser, p, s, NO_FLAGS, MODULES));
    completeGoFiles(files);
    const edges = goNameMatchEdges(files, 1, new Map(Object.entries(src)));
    const qn = (id: string): string => files.flatMap((f) => f.symbols).find((s) => s.id === id)!.qualifiedName;
    const calls = edges.filter((e) => e.kind === 'call').map((e) => `${qn(e.srcId)} -> ${qn(e.dstId)}`);
    // 测试包里查不到 Thing.Do，按被测包的键查到
    expect(calls.sort()).toEqual(['example.com/m/b.TestDo -> example.com/m/b.NewThing', 'example.com/m/b.TestDo -> example.com/m/b.Thing.Do']);
  });
});

describe('go symbol index with a same-named type in the external test package', () => {
  const sources: Record<string, string> = {
    'b/types.go': `package b

type Thing struct{}

type Holder struct {
	item *Thing
}
`,
    'b/thing.go': `package b

func (t *Thing) Do() {}
`,
    'b/x_test.go': `package b_test

type Thing struct{}

type Probe struct{}

type Holder struct {
	item *Probe
}
`,
    'b/y_test.go': `package b_test

func (t *Thing) Check() {}

func (p *Probe) Hit() {}

func TestHolder() {
	h := Holder{}
	h.item.Hit()
}
`,
    'b/z.go': `package b

func use() {
	h := Holder{}
	h.item.Do()
}
`,
  };

  it('keeps types, struct fields and method parents of the test package apart from the package under test', async () => {
    const parser = await getGoParser();
    const files = Object.entries(sources).map(([p, src]) => extractGoFile(parser, p, src, NO_FLAGS, MODULES));
    completeGoFiles(files);
    const sym = (path: string, name: string) => files.find((f) => f.path === path)!.symbols.find((s) => s.name === name)!;
    expect(sym('b/thing.go', 'Do').parentId).toBe(sym('b/types.go', 'Thing').id);
    expect(sym('b/y_test.go', 'Check').parentId).toBe(sym('b/x_test.go', 'Thing').id);
    const call = (path: string, name: string) => files.find((f) => f.path === path)!.go!.calls.find((c) => c.name === name);
    expect(call('b/y_test.go', 'Hit')?.receiverType).toBe('example.com/m/b.Probe');
    expect(call('b/z.go', 'Do')?.receiverType).toBe('example.com/m/b.Thing');
    const edges = goNameMatchEdges(files, 1, new Map(Object.entries(sources)));
    const qn = (id: string): string => files.flatMap((f) => f.symbols).find((s) => s.id === id)!.qualifiedName;
    const calls = edges.filter((e) => e.kind === 'call').map((e) => `${e.path}: ${qn(e.dstId)}`);
    expect(calls.sort()).toEqual(['b/y_test.go: example.com/m/b.Probe.Hit', 'b/z.go: example.com/m/b.Thing.Do']);
  });
});
