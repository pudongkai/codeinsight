import { describe, expect, it } from 'vitest';
import {
  dedupeQualifiedNames,
  detectLanguage,
  isGeneratedPath,
  isTestPath,
  makeSymbolKey,
  parseSymbolKey,
  supportLevelOf,
  symbolIdFromKey,
} from '../src/index.js';

describe('symbol key', () => {
  it('round-trips and has no line numbers', () => {
    const parts = { path: 'a/b.py', kind: 'method', qualifiedName: 'Svc.end_order', signature: '' };
    const key = makeSymbolKey(parts);
    expect(key).toBe('a/b.py#method#Svc.end_order#');
    expect(parseSymbolKey(key)).toEqual(parts);
  });

  it('parses dedup suffix and java signatures', () => {
    expect(parseSymbolKey('a.py#function#f#2#')).toEqual({ path: 'a.py', kind: 'function', qualifiedName: 'f#2', signature: '' });
    expect(parseSymbolKey('A.java#method#A.f#(String,int)').signature).toBe('(String,int)');
  });

  it('id is 16 hex chars and stable', () => {
    const id = symbolIdFromKey('a.py#function#f#');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(symbolIdFromKey('a.py#function#f#')).toBe(id);
  });

  it('dedupes repeated definitions in order', () => {
    const items = [1, 2, 3].map(() => ({ path: 'a.py', kind: 'function', qualifiedName: 'f', signature: '' }));
    expect(dedupeQualifiedNames(items).map((i) => i.qualifiedName)).toEqual(['f', 'f#2', 'f#3']);
  });
});

describe('language', () => {
  it('detects languages and support levels', () => {
    expect(detectLanguage('x/y.py')).toBe('python');
    expect(supportLevelOf('python')).toBe('full');
    expect(detectLanguage('A.java')).toBe('java');
    expect(supportLevelOf('java')).toBe('none');
    expect(detectLanguage('README.md')).toBe('unknown');
  });
});

describe('classify', () => {
  it('detects test code', () => {
    expect(isTestPath('tests/test_a.py')).toBe(true);
    expect(isTestPath('server/tests/helpers.py')).toBe(true);
    expect(isTestPath('pkg/test_x.py')).toBe(true);
    expect(isTestPath('pkg/x_test.py')).toBe(true);
    expect(isTestPath('conftest.py')).toBe(true);
    expect(isTestPath('pkg/testing.py')).toBe(false);
    expect(isTestPath('pkg/contest.py')).toBe(false);
    expect(isTestPath('e2e/flow.py', { testGlobs: ['e2e/**'] })).toBe(true);
  });

  it('detects generated code', () => {
    expect(isGeneratedPath('api/foo_pb2.py')).toBe(true);
    expect(isGeneratedPath('api/foo.py')).toBe(false);
    expect(isGeneratedPath('gen/x.py', { generatedGlobs: ['gen/**'] })).toBe(true);
  });
});
