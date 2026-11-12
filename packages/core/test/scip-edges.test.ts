import { describe, expect, it } from 'vitest';
import { continuedLines } from '../src/resolve/python-lines.js';
import { scipToEdges, SCIP_ROLE_DEFINITION } from '../src/index.js';
import type { ExtractedFile, ExtractedSymbol } from '../src/index.js';

function sym(over: Partial<ExtractedSymbol>): ExtractedSymbol {
  return {
    id: 'm', symbolKey: 'a.py#module#a#', kind: 'module', name: 'a', qualifiedName: 'a', signature: '', displaySignature: '',
    parentId: null, path: 'a.py', startLine: 1, endLine: 4, bodyHash: '', normTokens: [], docstring: null,
    isTest: false, isGenerated: false, modelKind: null, nameLine: 0, nameCol: 0, ...over,
  };
}

describe('scipToEdges', () => {
  it('reports the unmatched definition ratio as a note when it exceeds 1%', () => {
    const file: ExtractedFile = {
      path: 'a.py',
      symbols: [sym({}), sym({ id: 'f', symbolKey: 'a.py#function#f#', kind: 'function', name: 'f', qualifiedName: 'f', startLine: 1, endLine: 2, nameCol: 4 })],
      entries: [], importRows: [], djangoRoutes: [], imports: new Map(),
    };
    const def = (symbol: string, line: number, col: number) => ({
      symbol, roles: SCIP_ROLE_DEFINITION,
      range: { startLine: line, startChar: col, endLine: line, endChar: col + 1 },
      enclosingRange: { startLine: line, startChar: 0, endLine: line + 1, endChar: 0 },
    });
    const index = { documents: [{ relativePath: 'a.py', occurrences: [def('x/f().', 0, 4), def('x/g().', 2, 4)] }] };
    const result = scipToEdges(index, [file], new Map([['a.py', 'def f():\n  pass\ndef g():\n  pass\n']]), 1);
    expect(result.note).toBe('50.0% scip definitions unmatched (1 of 2)');

    const ok = scipToEdges({ documents: [{ relativePath: 'a.py', occurrences: [def('x/f().', 0, 4)] }] }, [file], new Map(), 1);
    expect(ok.note).toBeUndefined();
  });

  it('detects calls only within the same statement', () => {
    const source = [
      'def f():',           // 0
      '    return 1',       // 1
      'x = f',              // 2
      '(p, q) = 1, 2',      // 3
      'print(f',            // 4
      ')',                  // 5
      'y = f \\',            // 6
      '    (1)',            // 7
      'z = [f  # c',        // 8
      '     (2)]',          // 9
      's = "(" ; w = f',    // 10
      '',
    ].join('\n');
    const file: ExtractedFile = {
      path: 'a.py',
      symbols: [sym({ endLine: 11 }), sym({ id: 'f', symbolKey: 'a.py#function#f#', kind: 'function', name: 'f', qualifiedName: 'f', startLine: 1, endLine: 2, nameCol: 4 })],
      entries: [], importRows: [], djangoRoutes: [], imports: new Map(),
    };
    const lines = source.split('\n');
    const ref = (line: number) => {
      const col = lines[line]!.indexOf('f', line === 10 ? 12 : line === 4 ? 6 : 0);
      return { symbol: 'x/f().', roles: 0, range: { startLine: line, startChar: col, endLine: line, endChar: col + 1 } };
    };
    const def = {
      symbol: 'x/f().', roles: SCIP_ROLE_DEFINITION,
      range: { startLine: 0, startChar: 4, endLine: 0, endChar: 5 },
      enclosingRange: { startLine: 0, startChar: 0, endLine: 1, endChar: 12 },
    };
    const index = { documents: [{ relativePath: 'a.py', occurrences: [def, ...[2, 4, 6, 8, 10].map(ref)] }] };
    const kinds = scipToEdges(index, [file], new Map([['a.py', source]]), 1).edges.map((e) => `${e.line}:${e.kind}`);
    expect(kinds).toEqual(['3:reference', '5:reference', '7:call', '9:call', '11:reference']);
  });

  it('marks continued lines across escaped newlines in strings and CRLF line endings', () => {
    expect(continuedLines('x = dedent("""\\\ntext\n""")\ny = 1\n(a, b) = (1,\n  2)\n')).toEqual([true, true, false, false, true, false, false]);
    expect(continuedLines("s = 'ab\\\ncd'\nz = f\n(p) = 1\n")).toEqual([true, false, false, false, false]);
    expect(continuedLines('y = f \\\r\n    (1)\r\nz = 2  # c \\\r\nw = 3\r\n')).toEqual([true, false, false, false, false]);
  });

  it('detects a call after a backslash continuation in a CRLF file', () => {
    const source = 'def f():\r\n    return 1\r\ny = f \\\r\n    (1)\r\nz = f\r\n(p, q) = 1, 2\r\n';
    const file: ExtractedFile = {
      path: 'a.py',
      symbols: [sym({ endLine: 6 }), sym({ id: 'f', symbolKey: 'a.py#function#f#', kind: 'function', name: 'f', qualifiedName: 'f', startLine: 1, endLine: 2, nameCol: 4 })],
      entries: [], importRows: [], djangoRoutes: [], imports: new Map(),
    };
    const ref = (line: number) => ({ symbol: 'x/f().', roles: 0, range: { startLine: line, startChar: 4, endLine: line, endChar: 5 } });
    const def = {
      symbol: 'x/f().', roles: SCIP_ROLE_DEFINITION,
      range: { startLine: 0, startChar: 4, endLine: 0, endChar: 5 },
      enclosingRange: { startLine: 0, startChar: 0, endLine: 1, endChar: 12 },
    };
    const index = { documents: [{ relativePath: 'a.py', occurrences: [def, ref(2), ref(4)] }] };
    const kinds = scipToEdges(index, [file], new Map([['a.py', source]]), 1).edges.map((e) => `${e.line}:${e.kind}`);
    expect(kinds).toEqual(['3:call', '5:reference']);
  });
});
