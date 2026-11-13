import { appendFileSync, cpSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deserializeExtractedFile, extractCodeHash, fingerprintFiles, FINGERPRINT_EXTRA_MODULES, FINGERPRINT_IGNORED_MODULES,
  serializeExtractedFile,
} from '../src/extract/cache.js';
import { extractPythonFile, getPythonParser } from '../src/index.js';
import { scipResolverCodeHash } from '../src/resolve/scip-python.js';
import { tempDir } from './helpers/git-repo.js';

const SRC = path.resolve(import.meta.dirname, '..', 'src');

/** src 的临时副本，可选地在一个文件末尾追加一个字节 */
function srcCopy(touch?: string): string {
  const root = path.join(tempDir('ci-fingerprint-'), 'src');
  cpSync(SRC, root, { recursive: true });
  if (touch) appendFileSync(path.join(root, touch), ' ');
  return root;
}

const stripExt = (rel: string) => rel.replace(/\.(ts|js)$/, '');

/** 文件里相对路径 import 的项目模块（相对 SRC，不含扩展名） */
function relativeImports(rel: string): string[] {
  const text = readFileSync(path.join(SRC, rel), 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    out.push(stripExt(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]!))));
  }
  return out;
}

describe('extract code fingerprint', () => {
  it('changes when an extract module or symbol-key.ts changes, and not when log.ts changes', () => {
    const base = extractCodeHash(srcCopy());
    expect(extractCodeHash(srcCopy('extract/python.ts'))).not.toBe(base);
    expect(extractCodeHash(srcCopy('model/symbol-key.ts'))).not.toBe(base);
    expect(extractCodeHash(srcCopy('util/collections.ts'))).not.toBe(base);
    expect(extractCodeHash(srcCopy('log.ts'))).toBe(base);
  });

  it('changes the resolver code hash when a resolve or scip module changes', () => {
    const base = scipResolverCodeHash(srcCopy());
    expect(scipResolverCodeHash(srcCopy('resolve/scip-edges.ts'))).not.toBe(base);
    expect(scipResolverCodeHash(srcCopy('scip/reader.ts'))).not.toBe(base);
    expect(scipResolverCodeHash(srcCopy('log.ts'))).toBe(base);
  });

  it('covers every project module the fingerprinted modules import', () => {
    const listed = new Set(fingerprintFiles(SRC).map(stripExt));
    const allowed = new Set([...listed, ...FINGERPRINT_IGNORED_MODULES]);
    for (const mod of FINGERPRINT_EXTRA_MODULES) expect(listed.has(mod)).toBe(true);
    const missing = new Set<string>();
    for (const rel of fingerprintFiles(SRC)) {
      for (const imported of relativeImports(rel)) if (!allowed.has(imported)) missing.add(imported);
    }
    expect([...missing]).toEqual([]);
  });

  it('round-trips an extracted file through the cache format', async () => {
    const parser = await getPythonParser();
    const source = 'from sqlalchemy.orm import declarative_base\nfrom . import views\nBase = declarative_base()\n\nclass A(Base):\n    """doc"""\n    def f(self):\n        return 1\n';
    const file = extractPythonFile(parser, 'pkg/models.py', source, { isTest: false, isGenerated: false });
    expect(file.imports.size).toBeGreaterThan(0);
    expect(deserializeExtractedFile(serializeExtractedFile(file))).toEqual(file);
  });
});
