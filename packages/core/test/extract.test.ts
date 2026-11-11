import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractPythonFile, extractPythonFiles, getPythonParser, normalizeTokens } from '../src/index.js';
import type { ExtractResult, ExtractedSymbol } from '../src/index.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'py-basic');

function listFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((name) => {
    const rel = prefix ? `${prefix}/${name}` : name;
    return statSync(path.join(dir, name)).isDirectory() ? listFiles(path.join(dir, name), rel) : [rel];
  });
}

async function extractFixture(): Promise<ExtractResult> {
  const sources = listFiles(FIXTURE)
    .filter((f) => f.endsWith('.py'))
    .map((f) => ({ path: f, source: readFileSync(path.join(FIXTURE, f), 'utf8'), isTest: f.startsWith('tests/'), isGenerated: false }));
  return extractPythonFiles(sources);
}

async function extractSource(source: string, file = 'm.py'): Promise<ExtractedSymbol[]> {
  return extractPythonFile(await getPythonParser(), file, source, { isTest: false, isGenerated: false }).symbols;
}

describe('python extraction', () => {
  let result: ExtractResult;
  let byKey: Map<string, ExtractedSymbol>;
  beforeAll(async () => {
    result = await extractFixture();
    byKey = new Map(result.files.flatMap((f) => f.symbols).map((s) => [s.symbolKey, s]));
  });

  it('extracts module, class, method and nested function symbols', () => {
    expect(byKey.get('pkg/service.py#module#pkg.service#')).toMatchObject({ kind: 'module', name: 'service', startLine: 1 });
    expect(byKey.get('pkg/__init__.py#module#pkg#')).toMatchObject({ kind: 'module', name: 'pkg' });
    const cls = byKey.get('pkg/service.py#class#Service#')!;
    expect(cls).toMatchObject({ displaySignature: '(Base)', docstring: 'Service doc.', parentId: null });
    const helper = byKey.get('pkg/service.py#method#Service.helper#')!;
    expect(helper.parentId).toBe(cls.id);
    const inner = byKey.get('pkg/service.py#function#Service.helper.<locals>.inner#')!;
    expect(inner.parentId).toBe(helper.id);
    expect(byKey.get('pkg/repo.py#function#f#')).toMatchObject({ docstring: 'Join a path.', displaySignature: '(x)' });
  });

  it('suffixes duplicate definitions in order', () => {
    const first = byKey.get('pkg/service.py#function#dup#')!;
    const second = byKey.get('pkg/service.py#function#dup#2#')!;
    expect(first.startLine).toBeLessThan(second.startLine);
    expect(second.qualifiedName).toBe('dup#2');
    expect(first.id).not.toBe(second.id);
  });

  it('includes decorator lines in the range and builds display signatures without comments', () => {
    const getItem = byKey.get('pkg/api_fastapi.py#function#get_item#')!;
    expect(getItem.startLine).toBe(7);
    expect(getItem.nameLine).toBe(7);
    expect(getItem.displaySignature).toBe('(item_id: int, q: str | None = None) -> dict');
  });

  it('recognises framework entries', () => {
    const entries = result.entries.map((e) => {
      const sym = [...byKey.values()].find((s) => s.id === e.symbolId)!;
      return `${sym.qualifiedName}|${e.kind}|${e.framework}|${JSON.stringify(e.detail)}`;
    });
    expect(entries.sort()).toEqual([
      'ItemView|http|django|{"path":"^items/$","urls":"mysite/urls.py"}',
      'add_header|http|fastapi|{"middleware":"http"}',
      'add|task|celery|{}',
      'create_order|http|fastapi|{"method":"POST","path":"/orders"}',
      'get_item|http|fastapi|{"method":"GET","path":"/items/{item_id}"}',
      'grp|cli|click|{"type":"group"}',
      'hello|http|flask|{"method":"GET,POST","path":"/hello"}',
      'index|http|django|{"path":"index/","name":"index","urls":"mysite/urls.py"}',
      'main|cli|click|{"type":"command"}',
      'mul|task|celery|{"name":"demo.mul"}',
      'on_value_error|exception_handler|fastapi|{"exception":"ValueError"}',
      'ping|http|fastapi|{"method":"GET,HEAD","path":"/ping"}',
      'plain|http|flask|{"method":"GET","path":"/plain"}',
      'startup|event|fastapi|{"event":"startup"}',
      'sub|cli|click|{"type":"command","name":"sub"}',
    ]);
  });

  it('records import statement rows', () => {
    const service = result.files.find((f) => f.path === 'pkg/service.py')!;
    expect(service.importRows).toEqual([[0, 0], [2, 2], [3, 3]]);
  });

  it('keeps body hash stable when only indentation changes, and changes it when the body changes', async () => {
    const [, top] = await extractSource('def f(a):\n    return a + 1\n');
    const [, , nested] = await extractSource('class C:\n    def f(a):\n        return a + 1\n');
    const [, changed] = await extractSource('def f(a):\n    return a + 2\n');
    expect(nested!.bodyHash).toBe(top!.bodyHash);
    expect(changed!.bodyHash).not.toBe(top!.bodyHash);
  });

  it('hashes only the class itself: methods and placeholder pass / ... statements do not count', async () => {
    const [, withMethod] = await extractSource('class A:\n    """Doc."""\n    x = 1\n\n    def m(self):\n        return 1\n');
    const [, withPass] = await extractSource('class A:\n    """Doc."""\n    x = 1\n    pass\n');
    const [, withEllipsis] = await extractSource('class A:\n    """Doc."""\n    x = 1\n    ...\n');
    const [, changedAttr] = await extractSource('class A:\n    """Doc."""\n    x = 2\n    pass\n');
    expect(withPass!.bodyHash).toBe(withMethod!.bodyHash);
    expect(withEllipsis!.bodyHash).toBe(withMethod!.bodyHash);
    expect(changedAttr!.bodyHash).not.toBe(withMethod!.bodyHash);
    const [, emptyA] = await extractSource('class B:\n    pass\n');
    const [, filledA] = await extractSource('class B:\n    def m(self):\n        return 1\n');
    expect(emptyA!.bodyHash).toBe(filledA!.bodyHash);
  });

  it('finds the module docstring after leading comments', async () => {
    const [mod] = await extractSource('# -*- coding: utf-8 -*-\n# License header\n"""Module doc."""\nx = 1\n');
    expect(mod!.docstring).toBe('Module doc.');
  });

  it('keeps body hash stable for tab-indented code moved into a class', async () => {
    const [, top] = await extractSource('def f(a):\n\tif a:\n\t\treturn 1\n');
    const [, , nested] = await extractSource('class C:\n\tdef f(a):\n\t\tif a:\n\t\t\treturn 1\n');
    expect(nested!.bodyHash).toBe(top!.bodyHash);
  });

  it('hashes decorators and body but not the signature', async () => {
    const [, base] = await extractSource('@app.get("/a")\ndef f(a):\n    return 1\n');
    const [, route] = await extractSource('@app.get("/b")\ndef f(a):\n    return 1\n');
    const [, guarded] = await extractSource('@app.get("/a")\n@login_required\ndef f(a):\n    return 1\n');
    const [, sig] = await extractSource('@app.get("/a")\ndef f(a, b=2) -> int:\n    return 1\n');
    const [, , inClass] = await extractSource('class C:\n    @app.get("/a")\n    def f(a):\n        return 1\n');
    expect(route!.bodyHash).not.toBe(base!.bodyHash);
    expect(guarded!.bodyHash).not.toBe(base!.bodyHash);
    expect(sig!.bodyHash).toBe(base!.bodyHash);
    expect(sig!.displaySignature).toBe('(a, b=2) -> int');
    expect(sig!.displaySignature).not.toBe(base!.displaySignature);
    expect(inClass!.bodyHash).toBe(base!.bodyHash);
  });

  it('does not touch string literals when compacting display signatures', async () => {
    const [, f] = await extractSource('def f(a=" )", b="( x",\n      c=[ 1 , 2 ],  # note\n):\n    pass\n');
    expect(f!.displaySignature).toBe('(a=" )", b="( x", c=[1 , 2])');
  });

  it('drops a trailing comma only before the outermost closing parenthesis', async () => {
    const [, f] = await extractSource('def f(a={"k": (1, )}, b=[1, ],\n):\n    pass\n');
    expect(f!.displaySignature).toBe('(a={"k": (1,)}, b=[1,])');
  });

  it('normalizes tokens: identifiers and numbers replaced, strings kept, comments and docstring dropped', async () => {
    const [, f] = await extractSource('def f(x):\n    """doc"""\n    # note\n    return run("SELECT 1", x, 42)\n');
    expect(f!.normTokens).toEqual(['return', 'ID', '(', '"SELECT 1"', ',', 'ID', ',', 'NUM', ')']);
    expect(normalizeTokens([])).toEqual([]);
  });
});
