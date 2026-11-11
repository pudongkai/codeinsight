import { chmodSync, existsSync, lstatSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  commitMessages,
  diffCommits,
  diffWorking,
  exportArchive,
  listCommitFiles,
  listWorkingFiles,
  resolveRef,
  workingContentKey,
} from '../src/index.js';
import { commitAll, git, initRepo, tempDir, writeFiles } from './helpers/git-repo.js';

describe('git helpers', () => {
  it('diffs commit ranges with renames and counts', async () => {
    const repo = initRepo({ 'a.py': 'x = 1\n', 'b.py': 'def f():\n    return 1\n' + '# pad\n'.repeat(20), 'c.md': 'hi\n' });
    const base = await resolveRef(repo, 'HEAD');
    writeFiles(repo, { 'a.py': 'x = 2\ny = 3\n', 'c.md': null, 'd.py': 'z = 1\n' });
    git(repo, 'mv', 'b.py', 'pkg_b.py');
    const head = commitAll(repo, 'change\n\nbody');
    const files = await diffCommits(repo, base, head);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath['a.py']).toMatchObject({ status: 'modified', additions: 2, deletions: 1 });
    expect(byPath['c.md']).toMatchObject({ status: 'removed' });
    expect(byPath['d.py']).toMatchObject({ status: 'added', additions: 1 });
    expect(byPath['pkg_b.py']).toMatchObject({ status: 'renamed', oldPath: 'b.py' });
    expect(await listCommitFiles(repo, head)).toEqual(['a.py', 'd.py', 'pkg_b.py']);
    expect(await commitMessages(repo, base, head)).toContain('change');
  });

  it('lists working files with untracked, without ignored and data dir', async () => {
    const repo = initRepo({ '.gitignore': 'venv/\n', 'a.py': 'x = 1\n', 'gone.py': 'y = 1\n' });
    writeFiles(repo, {
      'new.py': 'n = 1\n', 'venv/lib.py': 'v = 1\n', '.codeinsight/snapshots/x/a.py': 'x = 1\n',
      'a.py': 'x = 2\n', 'gone.py': null,
    });
    const files = await listWorkingFiles(repo, ['.codeinsight']);
    expect(files).toEqual(['.gitignore', 'a.py', 'new.py']);
    const head = await resolveRef(repo, 'HEAD');
    const changes = await diffWorking(repo, head, ['.codeinsight']);
    const byPath = Object.fromEntries(changes.map((f) => [f.path, f.status]));
    expect(byPath).toEqual({ 'a.py': 'modified', 'gone.py': 'removed', 'new.py': 'added' });
  });

  it('working content key changes only when content changes', async () => {
    const repo = initRepo({ 'a.py': 'x = 1\n' });
    const head = await resolveRef(repo, 'HEAD');
    const k1 = await workingContentKey(repo, head);
    writeFileSync(path.join(repo, 'a.py'), 'x = 2\n');
    const k2 = await workingContentKey(repo, head);
    expect(k2).not.toBe(k1);
    expect(await workingContentKey(repo, head)).toBe(k2);
    expect(k1.startsWith(head)).toBe(true);
  });

  it('exports a commit with git archive without touching the repo', async () => {
    const repo = initRepo({ 'pkg/a.py': 'x = 1\n' });
    const sha = await resolveRef(repo, 'HEAD');
    writeFiles(repo, { 'pkg/a.py': 'x = 99\n' });
    const dest = path.join(tempDir(), 'snap');
    await exportArchive(repo, sha, dest);
    expect(readFileSync(path.join(dest, 'pkg/a.py'), 'utf8')).toBe('x = 1\n');
    expect(git(repo, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
    expect(existsSync(path.join(repo, '.git', 'worktrees'))).toBe(false);
  });

  it('exports exactly the ls-tree content regardless of export-ignore / export-subst', async () => {
    const repo = initRepo({
      '.gitattributes': 'tests/ export-ignore\na.py export-subst\n',
      'a.py': '# $Format:%H$\n',
      'tests/test_a.py': 'def test_a():\n    pass\n',
      'bin/run.sh': '#!/bin/sh\n',
    });
    chmodSync(path.join(repo, 'bin/run.sh'), 0o755);
    symlinkSync('a.py', path.join(repo, 'link.py'));
    const sha = commitAll(repo, 'more');
    const dest = path.join(tempDir(), 'snap dir');
    await exportArchive(repo, sha, dest);
    expect(readFileSync(path.join(dest, 'a.py'), 'utf8')).toBe('# $Format:%H$\n');
    expect(readFileSync(path.join(dest, 'tests/test_a.py'), 'utf8')).toContain('def test_a');
    expect(lstatSync(path.join(dest, 'link.py')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path.join(dest, 'link.py'))).toBe('a.py');
    expect(lstatSync(path.join(dest, 'bin/run.sh')).mode & 0o111).not.toBe(0);
  });

  it('reports a missing commit when exporting', async () => {
    const repo = initRepo({ 'a.py': 'x = 1\n' });
    await expect(exportArchive(repo, 'f'.repeat(40), path.join(tempDir(), 's'))).rejects.toThrow();
  });

  it('returns repo-root-relative paths when given a subdirectory', async () => {
    const repo = initRepo({ 'sub/b.py': 'b = 1\n', 'top.py': 't = 1\n' });
    const base = await resolveRef(repo, 'HEAD');
    writeFiles(repo, { 'sub/b.py': 'b = 2\n', 'sub/new.py': 'n = 1\n' });
    const sub = path.join(repo, 'sub');
    expect(await listCommitFiles(sub, base)).toEqual(['sub/b.py', 'top.py']);
    expect(await listWorkingFiles(sub)).toEqual(['sub/b.py', 'sub/new.py', 'top.py']);
    const changed = (await diffWorking(sub, base)).map((f) => f.path).sort();
    expect(changed).toEqual(['sub/b.py', 'sub/new.py']);
    expect(await workingContentKey(sub, base)).toBe(await workingContentKey(repo, base));
  });

  it('re-exports into an existing destination and handles large files', async () => {
    const big = 'x = 1\n'.repeat(2_000_000);
    const repo = initRepo({ 'a.py': 'a = 1\n', 'big.txt': big, 'empty.py': '' });
    symlinkSync('a.py', path.join(repo, 'link.py'));
    const sha = commitAll(repo, 'more');
    const dest = path.join(tempDir(), 'snap');
    await exportArchive(repo, sha, dest);
    writeFileSync(path.join(dest, 'stale.py'), 'left over');
    await exportArchive(repo, sha, dest);
    expect(existsSync(path.join(dest, 'stale.py'))).toBe(false);
    expect(readFileSync(path.join(dest, 'big.txt'), 'utf8')).toBe(big);
    expect(readFileSync(path.join(dest, 'empty.py'), 'utf8')).toBe('');
    expect(readlinkSync(path.join(dest, 'link.py'))).toBe('a.py');
  });

  it('leaves submodules out of file lists, diffs and exports', async () => {
    const sub = initRepo({ 'lib.py': 'l = 1\n' });
    const repo = initRepo({ 'a.py': 'a = 1\n' });
    const base = await resolveRef(repo, 'HEAD');
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub');
    const head = commitAll(repo, 'add submodule');
    expect(await listCommitFiles(repo, head)).toEqual(['.gitmodules', 'a.py']);
    expect(await listWorkingFiles(repo)).toEqual(['.gitmodules', 'a.py']);
    expect((await diffCommits(repo, base, head)).map((f) => f.path)).toEqual(['.gitmodules']);
    const dest = path.join(tempDir(), 'snap');
    await exportArchive(repo, head, dest);
    expect(existsSync(path.join(dest, 'vendor/sub'))).toBe(false);
  });

  it('diffs commits relative to the repo root even with diff.relative set', async () => {
    const repo = initRepo({ 'a.py': 'a = 1\n', 'sub/b.py': 'b = 1\n' });
    const base = await resolveRef(repo, 'HEAD');
    writeFiles(repo, { 'a.py': 'a = 2\n', 'sub/b.py': 'b = 2\n' });
    const head = commitAll(repo, 'change');
    git(repo, 'config', 'diff.relative', 'true');
    const paths = (await diffCommits(path.join(repo, 'sub'), base, head)).map((f) => f.path).sort();
    expect(paths).toEqual(['a.py', 'sub/b.py']);
  });
});
