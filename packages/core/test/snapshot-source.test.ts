import { cpSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildSnapshot, checkRelativePath, initDataDir, loadConfig, PathNotAllowedError, readSnapshotFile, resolveInside, setLogSink, sliceLines, snapshotDir, SnapshotFileError, Store,
} from '../src/index.js';
import type { Resolver, SnapshotFileContext, SnapshotRow } from '../src/index.js';
import { commitAll, git, tempDir } from './helpers/git-repo.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'py-basic');
const REPO_PY = 'import os\n';

/** 不产生边的解析器：这里只关心文件读取 */
const noResolver: Resolver = { name: 'none', resolve: async () => ({ edges: [] }) };

let repo: string;
let outside: string;
let ctx: SnapshotFileContext;
let working: SnapshotRow;
let commit: SnapshotRow;
let prevSink: ((line: string) => void) | undefined;

async function build(ref?: string): Promise<SnapshotRow> {
  const config = await loadConfig(repo, { dataDir: ctx.layout.root });
  return (await buildSnapshot({ repo, store: ctx.store, layout: ctx.layout, config, ref, resolver: noResolver })).snapshot;
}

async function readError(snap: SnapshotRow, rel: string, maxBytes?: number): Promise<unknown> {
  return readSnapshotFile(ctx, snap, rel, { maxBytes }).then(() => undefined, (err: unknown) => err);
}

function codeOf(err: unknown): string | undefined {
  return err instanceof PathNotAllowedError || err instanceof SnapshotFileError ? err.code : undefined;
}

beforeAll(async () => {
  prevSink = setLogSink(() => {});
  repo = tempDir('ci-source-');
  cpSync(FIXTURE, repo, { recursive: true });
  outside = tempDir('ci-outside-');
  writeFileSync(path.join(outside, 'secret.py'), 'SECRET = "top-secret"\n');
  // 提交里的绝对路径符号链接，指向仓库外
  symlinkSync(path.join(outside, 'secret.py'), path.join(repo, 'pkg', 'committed_leak.py'));
  git(repo, 'init', '-q', '-b', 'main');
  commitAll(repo, 'init');
  const layout = await initDataDir(tempDir('ci-source-data-'));
  ctx = { repo, store: new Store(layout.dbPath), layout };
  commit = await build('HEAD');
  // 工作区：指向仓库内其他文件的绝对路径链接、指向仓库外的链接
  symlinkSync(path.join(repo, 'pkg', 'repo.py'), path.join(repo, 'pkg', 'alias.py'));
  symlinkSync(path.join(outside, 'secret.py'), path.join(repo, 'pkg', 'leak.py'));
  working = await build();
});

afterAll(() => {
  ctx?.store.close();
  if (prevSink) setLogSink(prevSink);
});

describe('path checks', () => {
  it('rejects malformed relative paths', () => {
    for (const p of ['', '../x.py', 'pkg/../../x.py', '/etc/passwd', 'C:/x.py', 'pkg\\x.py', 'pkg//x.py', './pkg/x.py', 'a\0b']) {
      expect(() => checkRelativePath(p), p).toThrow(PathNotAllowedError);
    }
    expect(() => checkRelativePath('pkg/repo.py')).not.toThrow();
  });

  it('resolves inside the root, returns undefined for missing files and rejects links leaving the root', async () => {
    expect(await resolveInside(repo, 'pkg/repo.py')).toMatch(/pkg[/\\]repo\.py$/);
    expect(await resolveInside(repo, 'pkg/missing.py')).toBeUndefined();
    await expect(resolveInside(repo, 'pkg/leak.py')).rejects.toBeInstanceOf(PathNotAllowedError);
  });
});

describe('readSnapshotFile', () => {
  it('rejects ../, absolute paths and files outside the file list', async () => {
    expect(codeOf(await readError(working, '../outside.py'))).toBe('path_not_allowed');
    expect(codeOf(await readError(working, '/etc/passwd'))).toBe('path_not_allowed');
    expect(codeOf(await readError(working, '.git/config'))).toBe('not_in_snapshot');
  });

  it('rejects symlinks pointing outside the repository', async () => {
    expect(ctx.store.getFile(working.id, 'pkg/leak.py')).toBeDefined();
    expect(codeOf(await readError(working, 'pkg/leak.py'))).toBe('path_not_allowed');
    expect(ctx.store.getFile(commit.id, 'pkg/committed_leak.py')).toBeDefined();
    expect(codeOf(await readError(commit, 'pkg/committed_leak.py'))).toBe('path_not_allowed');
  });

  it('reads an absolute symlink to another file in the repository from the working tree', async () => {
    expect(await readSnapshotFile(ctx, working, 'pkg/alias.py')).toBe(await readSnapshotFile(ctx, working, 'pkg/repo.py'));
  });

  it('enforces the size limit', async () => {
    expect(codeOf(await readError(working, 'pkg/repo.py', 10))).toBe('file_too_large');
  });

  it('falls back to the working tree when the snapshot copy is missing', async () => {
    rmSync(path.join(snapshotDir(ctx.layout, working.contentKey), 'pkg', 'tasks.py'));
    const target = path.join(repo, 'pkg', 'tasks.py');
    const original = readFileSync(target, 'utf8');
    try {
      expect(await readSnapshotFile(ctx, working, 'pkg/tasks.py')).toBe(original);
      writeFileSync(target, 'changed = 1\n');
      expect(codeOf(await readError(working, 'pkg/tasks.py'))).toBe('file_changed');
    } finally {
      writeFileSync(target, original);
    }
  });

  it('reads the snapshot copy of Python files and checks the content hash of files read from the working tree', async () => {
    const before = await readSnapshotFile(ctx, working, 'pkg/repo.py');
    expect(before.startsWith(REPO_PY)).toBe(true);
    const readme = await readSnapshotFile(ctx, working, 'README.md');
    expect(readme.length).toBeGreaterThan(0);

    writeFileSync(path.join(repo, 'pkg', 'repo.py'), 'changed = 1\n');
    writeFileSync(path.join(repo, 'README.md'), 'changed\n');
    expect(await readSnapshotFile(ctx, working, 'pkg/repo.py')).toBe(before);
    expect(codeOf(await readError(working, 'README.md'))).toBe('file_changed');
    // 指向仓库内文件的链接读的是工作区，目标改了同样返回 file_changed
    expect(codeOf(await readError(working, 'pkg/alias.py'))).toBe('file_changed');
    // 提交快照读导出的快照目录，不受工作区影响
    expect(await readSnapshotFile(ctx, commit, 'README.md')).toBe(readme);
  });
});

describe('sliceLines', () => {
  it('returns an inclusive line range, clamps the end and rejects an end before the start', () => {
    expect(sliceLines('a\r\nb\nc', 2)).toEqual({ start: 2, end: 3, totalLines: 3, content: 'b\nc' });
    expect(sliceLines('a\nb\nc', 1, 99)).toEqual({ start: 1, end: 3, totalLines: 3, content: 'a\nb\nc' });
    expect(sliceLines('a\nb\nc', 3, 2)).toBeUndefined();
  });

  it('moves a start beyond the end of the file back to the end, keeping the requested length', () => {
    const text = Array.from({ length: 100 }, (_, i) => `l${i + 1}`).join('\n');
    expect(sliceLines(text, 300, 349)).toMatchObject({ start: 51, end: 100, totalLines: 100 });
    expect(sliceLines(text, 300, 700)).toMatchObject({ start: 1, end: 100 });
    expect(sliceLines('a\nb', 5)).toEqual({ start: 2, end: 2, totalLines: 2, content: 'b' });
  });
});
