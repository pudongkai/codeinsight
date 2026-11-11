import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
});
