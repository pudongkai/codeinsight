import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { deserializeExtractedFile, serializeExtractedFile } from '../src/extract/cache.js';
import { collectGoModules } from '../src/extract/go-module.js';
import {
  collectGoEnvReads, collectGoImports, completeForResolve, extractFiles, extractGoFile, getGoParser, goModuleOf, goPackagePath,
  GoSymbolIndex, parseGoModulePath, restoreGoFile,
} from '../src/index.js';
import type { ExtractResult, ExtractedFile, ExtractedSymbol } from '../src/index.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'go-basic');
const MODULES = new Map([['backend', 'example.com/gobasic']]);
const PKG = 'example.com/gobasic/internal/order';
const NO_FLAGS = { isTest: false, isGenerated: false };

function listGoFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((name) => {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(path.join(dir, name)).isDirectory()) return name === 'vendor' ? [] : listGoFiles(path.join(dir, name), rel);
    return rel.endsWith('.go') ? [rel] : [];
  });
}

async function extractFixture(): Promise<ExtractResult> {
  const sources = listGoFiles(FIXTURE).map((f) => ({
    path: f, language: 'go' as const, source: readFileSync(path.join(FIXTURE, f), 'utf8'), isTest: f.endsWith('_test.go'), isGenerated: false,
  }));
  return extractFiles(sources, { goModules: MODULES });
}

async function extractOne(source: string, file = 'm/a.go', modules = new Map([['', 'example.com/m']])): Promise<ExtractedFile> {
  return extractGoFile(await getGoParser(), file, source, NO_FLAGS, modules);
}

describe('go module paths', () => {
  it('collects go.mod files from a path list, skipping other files, vendor and testdata, and reporting read failures', async () => {
    const texts: Record<string, string> = {
      'go.mod': 'module example.com/root\n', 'svc/go.mod': 'go 1.22\n', 'vendor/x/go.mod': 'module x\n', 'testdata/go.mod': 'module t\n',
    };
    const read = vi.fn(async (p: string) => {
      if (!(p in texts)) throw new Error(`missing ${p}`);
      return texts[p]!;
    });
    const failed: string[] = [];
    const paths = ['a.go', 'go.mod', 'svc/go.mod', 'vendor/x/go.mod', 'testdata/go.mod', 'lib/go.mod'];
    const modules = await collectGoModules(paths, read, (p) => failed.push(p));
    expect([...modules]).toEqual([['', 'example.com/root']]);
    expect(read.mock.calls.map(([p]) => p)).toEqual(['go.mod', 'svc/go.mod', 'lib/go.mod']);
    expect(failed).toEqual(['lib/go.mod']);
  });

  it('parses the module line and finds the nearest go.mod', () => {
    expect(parseGoModulePath('// x\nmodule example.com/a // comment\n\ngo 1.22\n')).toBe('example.com/a');
    expect(parseGoModulePath('go 1.22\n')).toBeUndefined();
    const modules = new Map([['', 'example.com/root'], ['svc', 'example.com/svc']]);
    expect(goModuleOf('svc/x/a.go', modules)).toEqual({ dir: 'svc', module: 'example.com/svc' });
    expect(goPackagePath('svc/x/a.go', modules, 'x')).toBe('example.com/svc/x');
    expect(goPackagePath('svc/a.go', modules, 'svc')).toBe('example.com/svc');
    expect(goPackagePath('lib/a.go', modules, 'lib')).toBe('example.com/root/lib');
    expect(goPackagePath('lib/a.go', new Map(), 'lib')).toBe('lib');
    expect(goPackagePath('main.go', new Map(), 'main')).toBe('main');
  });
});

describe('go extraction', () => {
  let result: ExtractResult;
  let byQn: Map<string, ExtractedSymbol>;
  beforeAll(async () => {
    result = await extractFixture();
    byQn = new Map(result.files.flatMap((f) => f.symbols).map((s) => [`${s.kind} ${s.qualifiedName}`, s]));
  });

  it('extracts module, function, method, struct and interface symbols with Go names', () => {
    const file = result.files.find((f) => f.path === 'backend/internal/order/service.go')!;
    expect(file.language).toBe('go');
    expect(file.symbols[0]).toMatchObject({ kind: 'module', name: 'service.go', qualifiedName: `${PKG}/service.go`, parentId: null });
    const svc = byQn.get(`class ${PKG}.Service`)!;
    expect(svc).toMatchObject({ name: 'Service', displaySignature: 'type Service struct', docstring: 'Service creates and looks up orders.' });
    expect(byQn.get(`method ${PKG}.Service.Create`)).toMatchObject({
      signature: '', parentId: svc.id, startLine: 20, nameLine: 19, nameCol: 18,
      displaySignature: 'func (s *Service) Create(item string, qty int) (*Order, error)', docstring: 'Create stores a new order.',
    });
    expect(byQn.get(`method ${PKG}.Service.Get`)!.parentId).toBe(svc.id);
    expect(byQn.get(`function ${PKG}.NewService`)).toMatchObject({ parentId: file.symbols[0]!.id, displaySignature: 'func NewService(repo Repo) *Service' });
    expect(byQn.get(`function example.com/gobasic/cmd/server.main`)).toBeDefined();
  });

  it('extracts interfaces and their declared methods', () => {
    const repo = byQn.get(`interface ${PKG}.Repo`)!;
    expect(repo.docstring).toBe('Repo stores orders.');
    expect(byQn.get(`method ${PKG}.Repo.Find`)).toMatchObject({
      parentId: repo.id, displaySignature: 'Find(id int) (*Order, error)', docstring: 'Find returns the order with the given id.', normTokens: [],
    });
    expect(byQn.get(`method ${PKG}.Repo.Save`)!.parentId).toBe(repo.id);
  });

  it('suffixes duplicate init functions', () => {
    const first = byQn.get(`function ${PKG}.init`)!;
    const second = byQn.get(`function ${PKG}.init#2`)!;
    expect(first.startLine).toBeLessThan(second.startLine);
    expect(first.id).not.toBe(second.id);
  });

  it('records the package doc comment on the module symbol and test flags', () => {
    expect(byQn.get(`module ${PKG}/doc.go`)!.docstring).toBe('Package order manages orders.');
    expect(byQn.get(`function ${PKG}.TestCreate`)!.isTest).toBe(true);
  });

  it('hashes the whole declaration and normalizes body tokens', () => {
    const create = byQn.get(`method ${PKG}.Service.Create`)!;
    const get = byQn.get(`method ${PKG}.Service.Get`)!;
    expect(create.bodyHash).not.toBe(get.bodyHash);
    expect(create.normTokens).toContain('ID');
    expect(create.normTokens).not.toContain('nextID');
    expect(byQn.get(`function ${PKG}.NewService`)!.normTokens).toContain('NUM');
  });

  it('collects imports, struct tags and env reads', () => {
    const main = result.files.find((f) => f.path === 'backend/cmd/server/main.go')!;
    expect(main.go).toMatchObject({ packageName: 'main', packagePath: 'example.com/gobasic/cmd/server', envReads: ['ADDR'] });
    expect(main.go!.imports).toEqual({ fmt: 'fmt', http: 'net/http', os: 'os', order: PKG });
    expect(main.importRows).toEqual([[2, 8]]);
    const model = result.files.find((f) => f.path === 'backend/internal/order/model.go')!;
    expect(model.go!.structTags[byQn.get(`class ${PKG}.Order`)!.id]).toEqual({ keys: ['gorm', 'json'], gormModel: false });
    expect(model.go!.structTags[byQn.get(`class ${PKG}.Summary`)!.id]).toEqual({ keys: ['json'], gormModel: false });
  });

  it('collects call sites with forms and inferred receiver types', () => {
    const service = result.files.find((f) => f.path === 'backend/internal/order/service.go')!;
    const calls = service.go!.calls.map((c) => ({ form: c.form, name: c.name, qualifier: c.qualifier, receiverType: c.receiverType }));
    expect(calls).toContainEqual({ form: 'ident', name: 'validate', qualifier: undefined, receiverType: undefined });
    expect(calls).toContainEqual({ form: 'pkg', name: 'Errorf', qualifier: 'fmt', receiverType: undefined });
    expect(calls).toContainEqual({ form: 'selector', name: 'Save', qualifier: undefined, receiverType: `${PKG}.Repo` });
    expect(calls).toContainEqual({ form: 'selector', name: 'Find', qualifier: undefined, receiverType: `${PKG}.Repo` });
    const main = result.files.find((f) => f.path === 'backend/cmd/server/main.go')!;
    const create = main.go!.calls.find((c) => c.name === 'Create')!;
    const handler = main.symbols.find((s) => s.qualifiedName === 'example.com/gobasic/cmd/server.main.func1')!;
    expect(create).toMatchObject({ form: 'selector', receiverType: `${PKG}.Service`, callerId: handler.id });
  });

  it('keeps the go field through the extract cache format', () => {
    const main = result.files.find((f) => f.path === 'backend/cmd/server/main.go')!;
    const back = deserializeExtractedFile(serializeExtractedFile(main));
    expect(back).toEqual(main);
    expect(Object.keys(back.go!.imports).length).toBeGreaterThan(0);
  });
});

describe('go cross-file processing', () => {
  it('links methods to types declared in another file of the same package', async () => {
    const parser = await getGoParser();
    const modules = new Map([['', 'example.com/m']]);
    const a = extractGoFile(parser, 'p/a.go', 'package p\n\ntype T struct{ r R }\n\ntype R interface{ Do() }\n', NO_FLAGS, modules);
    const b = extractGoFile(parser, 'p/b.go', 'package p\n\nfunc (t *T) Run() { t.r.Do() }\n\nfunc NewT() *T { return &T{} }\n', NO_FLAGS, modules);
    const c = extractGoFile(parser, 'q/c.go', 'package q\n\nimport "example.com/m/p"\n\nfunc F() { x := p.NewT(); x.Run() }\n', NO_FLAGS, modules);
    const run = b.symbols.find((s) => s.name === 'Run')!;
    expect(run.parentId).toBe(b.symbols[0]!.id);
    expect(b.go!.calls[0]).toMatchObject({ name: 'Do', receiverChain: { root: { type: 'example.com/m/p.T' }, fields: ['r'] } });
    expect(b.go!.calls[0]!.receiverType).toBeUndefined();
    await extractFiles([]);
    completeForResolve([a, b, c]);
    expect(run.parentId).toBe(a.symbols.find((s) => s.name === 'T')!.id);
    expect(b.go!.calls[0]!.receiverType).toBe('example.com/m/p.R');
    expect(c.go!.calls.find((x) => x.name === 'Run')!.receiverType).toBe('example.com/m/p.T');
  });

  it('indexes functions, methods, types and representative files', async () => {
    const result = await extractFixture();
    const index = new GoSymbolIndex(result.files);
    expect(index.func(PKG, 'NewService')?.qualifiedName).toBe(`${PKG}.NewService`);
    expect(index.method(PKG, 'Service', 'Create')?.kind).toBe('method');
    expect(index.method(PKG, 'Repo', 'Find')?.qualifiedName).toBe(`${PKG}.Repo.Find`);
    expect(index.type(PKG, 'Repo')?.kind).toBe('interface');
    expect(index.methodsNamed('Find').length).toBe(2);
    expect(index.representative(PKG)?.path).toBe('backend/internal/order/doc.go');
    expect(index.representative('example.com/gobasic/cmd/server')?.path).toBe('backend/cmd/server/main.go');
    expect(index.representative('example.com/other')).toBeUndefined();
  });

  it('picks the first non-test file by name when no file has a package doc comment', async () => {
    const parser = await getGoParser();
    const modules = new Map([['', 'example.com/m']]);
    const files = [
      extractGoFile(parser, 'p/z.go', 'package p\n', NO_FLAGS, modules),
      extractGoFile(parser, 'p/a_test.go', 'package p\n', { isTest: true, isGenerated: false }, modules),
      extractGoFile(parser, 'p/b.go', 'package p\n', NO_FLAGS, modules),
    ];
    expect(new GoSymbolIndex(files).representative('example.com/m/p')?.path).toBe('p/b.go');
  });
});

describe('go restore', () => {
  it('rebuilds the go field and name positions from stored symbols', async () => {
    const parser = await getGoParser();
    const source = readFileSync(path.join(FIXTURE, 'backend/internal/order/service.go'), 'utf8');
    const file = extractGoFile(parser, 'backend/internal/order/service.go', source, NO_FLAGS, MODULES);
    const rows = file.symbols.map(({ nameLine: _l, nameCol: _c, ...s }) => s);
    const restored = restoreGoFile(parser, file.path, source, rows.reverse(), MODULES);
    expect(restored.symbols).toEqual(file.symbols);
    expect(restored.go).toEqual(file.go);
    expect(restored.importRows).toEqual(file.importRows);
  });
});

describe('go import and env helpers', () => {
  it('handles aliases, blank and dot imports', async () => {
    const source = [
      'package a', '', 'import (', '\t"fmt"', '\tyaml "gopkg.in/yaml.v3"', '\t_ "embed"', '\t. "strings"',
      '\t"github.com/go-chi/chi/v5"', '\tenv "os"', ')', '',
      'func F() { env.Getenv("A"); env.LookupEnv(`B`); env.Getenv(name); fmt.Println(ToUpper("x")) }', '',
    ].join('\n');
    const file = await extractOne(source);
    expect(file.go!.imports).toEqual({ fmt: 'fmt', yaml: 'gopkg.in/yaml.v3', chi: 'github.com/go-chi/chi/v5', env: 'os' });
    expect(file.go!.dotImports).toEqual(['strings']);
    expect(file.go!.envReads).toEqual(['A', 'B']);
    expect(file.go!.calls.map((c) => `${c.form}:${c.name}`)).toEqual(['pkg:Getenv', 'pkg:LookupEnv', 'pkg:Getenv', 'pkg:Println', 'ident:ToUpper']);
    const parser = await getGoParser();
    const tree = parser.parse(source)!;
    expect(collectGoImports(tree.rootNode).map((i) => i.alias ?? i.path)).toEqual(['fmt', 'yaml', '_', '.', 'github.com/go-chi/chi/v5', 'env']);
    expect(collectGoEnvReads(tree.rootNode)).toEqual(['A', 'B']);
    tree.delete();
  });

  it('records embedded gorm.Model and skips builtin calls', async () => {
    const file = await extractOne('package a\n\nimport "gorm.io/gorm"\n\ntype U struct {\n\tgorm.Model\n\tName string\n}\n\nfunc F(xs []int) int { return len(xs) }\n');
    const u = file.symbols.find((s) => s.name === 'U')!;
    expect(file.go!.structTags[u.id]).toEqual({ keys: [], gormModel: true });
    expect(file.go!.calls).toEqual([]);
  });

  it('builds type symbols in grouped declarations and ignores non-struct types', async () => {
    const file = await extractOne('package a\n\ntype (\n\t// A doc.\n\tA struct{}\n\tB int\n\tC[T any] interface{ M() T }\n)\n');
    expect(file.symbols.map((s) => `${s.kind} ${s.qualifiedName}`)).toEqual([
      'module example.com/m/m/a.go', 'class example.com/m/m.A', 'interface example.com/m/m.C', 'method example.com/m/m.C.M',
    ]);
    expect(file.symbols[1]).toMatchObject({ docstring: 'A doc.', startLine: 5, endLine: 5 });
    expect(file.symbols[2]!.displaySignature).toBe('type C[T any] interface');
  });
});
