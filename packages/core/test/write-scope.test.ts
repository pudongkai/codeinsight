import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkWritePath, isSensitivePath, normalizeSegment, resolveWriteTarget, WriteNotAllowedError } from '../src/index.js';
import type { WriteScope } from '../src/index.js';
import { tempDir } from './helpers/git-repo.js';

const ZWSP = String.fromCharCode(0x200b);

function rejected(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(WriteNotAllowedError);
    return (err as WriteNotAllowedError).reason;
  }
  throw new Error('expected WriteNotAllowedError');
}

async function rejectedAsync(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(WriteNotAllowedError);
  return (err as WriteNotAllowedError).reason;
}

describe('checkWritePath', () => {
  it('accepts ordinary relative paths', () => {
    for (const p of ['src/a.py', 'README.md', '.github/workflows/ci.yml', 'docs/新文件.md', '.gitignore']) expect(() => checkWritePath(p, 'linux')).not.toThrow();
  });

  it('rejects absolute paths, .., empty segments, backslashes, drive letters and control characters', () => {
    for (const p of ['/etc/passwd', '../x', 'a/../b', 'a//b', './a', 'a\\b', 'C:/x', 'C:\\x', 'a/b\0', 'a\nb', '']) {
      expect(rejected(() => checkWritePath(p, 'linux'))).toContain('relative');
    }
  });

  it('rejects forbidden directories after case folding, trailing dots / spaces and zero-width characters', () => {
    const cases = ['.git/config', '.GIT/hooks/pre-commit', '.git./config', '.git /config', `.g${ZWSP}it/hooks/x`, `.git${String.fromCharCode(0xfeff)}/x`,
      'node_modules/a/index.js', 'pkg/Node_Modules/x', '.husky/pre-commit', '.githooks/pre-push', 'a/.codeinsight/index.db', 'a/.CodeInsight./x'];
    for (const p of cases) expect(rejected(() => checkWritePath(p, 'linux'))).toMatch(/writing inside \.git|node_modules|\.husky|\.githooks|\.codeinsight/);
  });

  it('strips the deprecated format characters U+206A-U+206F too', () => {
    for (const code of [0x206a, 0x206c, 0x206f]) {
      expect(rejected(() => checkWritePath(`.gi${String.fromCharCode(code)}t/config`, 'linux'))).toContain('.git');
    }
  });

  it('normalizes segments with NFC before comparing', () => {
    expect(normalizeSegment('Cafe\u0301')).toBe('café');
    expect(normalizeSegment(`.Git${ZWSP}.. `)).toBe('.git');
  });

  it('rejects segments that are empty after normalization', () => {
    expect(rejected(() => checkWritePath('a/.../b', 'linux'))).toContain('not a valid path segment');
  });

  it('on Windows also rejects ":", reserved device names and 8.3 short names', () => {
    expect(rejected(() => checkWritePath('a/b:stream', 'win32'))).toContain(':');
    expect(rejected(() => checkWritePath('a/NUL.txt', 'win32'))).toContain('reserved');
    expect(rejected(() => checkWritePath('com1', 'win32'))).toContain('reserved');
    expect(rejected(() => checkWritePath('PROGRA~1/x', 'win32'))).toContain('short');
    expect(() => checkWritePath('a/b:stream', 'linux')).not.toThrow();
    expect(() => checkWritePath('src/console.ts', 'win32')).not.toThrow();
  });
});

describe('resolveWriteTarget', () => {
  let root: string;
  let outside: string;
  let dataDir: string;
  let home: string;
  let scope: WriteScope;

  beforeAll(() => {
    root = tempDir('ci-wscope-root-');
    outside = tempDir('ci-wscope-out-');
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'a.py'), 'x = 1\n');
    writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
    symlinkSync(outside, path.join(root, 'out-link'));
    symlinkSync(path.join(root, 'src', 'a.py'), path.join(root, 'src', 'alias.py'));
    mkdirSync(path.join(outside, 'subdir'));
    symlinkSync(path.join(root, 'missing-target'), path.join(root, 'dangling'));
    symlinkSync(path.join(outside, 'gone'), path.join(root, 'dangling-out'));
    // 数据目录改了名（如 CODEINSIGHT_DATA_DIR=ci-data），只能按真实路径判断
    dataDir = path.join(root, 'ci-data');
    mkdirSync(dataDir);
    home = path.join(root, 'ci-home');
    mkdirSync(home);
    scope = { root, excluded: [dataDir, home], platform: 'linux' };
  });

  it('resolves existing files and new files in new directories', async () => {
    expect(await resolveWriteTarget(scope, 'src/a.py')).toMatchObject({ exists: true });
    const t = await resolveWriteTarget(scope, 'docs/guide/new.md');
    expect(t.exists).toBe(false);
    expect(path.basename(t.abs)).toBe('new.md');
  });

  it('rejects a path through a symlink that points outside the root', async () => {
    expect(await rejectedAsync(resolveWriteTarget(scope, 'out-link/secret.txt'))).toContain('symbolic link');
    expect(await rejectedAsync(resolveWriteTarget(scope, 'out-link/new.txt'))).toContain('outside the root');
  });

  it('checks the root before looking at the target, so nothing about targets outside is revealed', async () => {
    expect(await rejectedAsync(resolveWriteTarget(scope, 'out-link/subdir'))).toContain('outside the root');
  });

  it('rejects paths through broken symlinks and broken symlinks as targets', async () => {
    expect(await rejectedAsync(resolveWriteTarget(scope, 'dangling/new.txt'))).toContain('broken symbolic link');
    expect(await rejectedAsync(resolveWriteTarget(scope, 'dangling-out/a/b.txt'))).toContain('broken symbolic link');
    expect(await rejectedAsync(resolveWriteTarget(scope, 'dangling'))).toContain('broken symbolic link');
  });

  it('with home given, rejects hidden directories and Library under it', async () => {
    const homeScope = { root: home, excluded: [], home, platform: 'linux' as const };
    mkdirSync(path.join(home, '.ssh'), { recursive: true });
    expect(await rejectedAsync(resolveWriteTarget(homeScope, '.ssh/authorized_keys'))).toContain('hidden directories or Library');
    expect(await rejectedAsync(resolveWriteTarget(homeScope, 'Library/LaunchAgents/x.plist'))).toContain('hidden directories or Library');
    expect(await resolveWriteTarget(homeScope, 'notes/x.md')).toMatchObject({ exists: false });
    expect(await resolveWriteTarget({ ...homeScope, home: undefined }, '.ssh/authorized_keys')).toMatchObject({ exists: false });
  });

  it('rejects a target that is a symlink even when it points inside', async () => {
    expect(await rejectedAsync(resolveWriteTarget(scope, 'src/alias.py'))).toContain('symbolic link');
  });

  it('rejects the renamed data directory and CODEINSIGHT_HOME by real path', async () => {
    expect(await rejectedAsync(resolveWriteTarget(scope, 'ci-data/index.db'))).toContain('data or settings directory');
    expect(await rejectedAsync(resolveWriteTarget(scope, 'ci-data/new/x.txt'))).toContain('data or settings directory');
    expect(await rejectedAsync(resolveWriteTarget(scope, 'ci-home/settings.json'))).toContain('data or settings directory');
  });

  it('rejects paths below a file and directories as targets', async () => {
    expect(await rejectedAsync(resolveWriteTarget(scope, 'src/a.py/x'))).toContain('not a directory');
    expect(await rejectedAsync(resolveWriteTarget(scope, 'src'))).toContain('not a regular file');
  });

  it('rejects a root that no longer exists', async () => {
    expect(await rejectedAsync(resolveWriteTarget({ ...scope, root: path.join(root, 'gone') }, 'a.txt'))).toContain('no longer exists');
  });

  it('applies the name checks before touching the disk', async () => {
    expect(await rejectedAsync(resolveWriteTarget(scope, '.GIT/hooks/pre-commit'))).toContain('.git');
    expect(await rejectedAsync(resolveWriteTarget(scope, '../x'))).toContain('relative');
  });
});

describe('sensitive paths', () => {
  it('marks files and directories that tools run automatically', () => {
    for (const p of [
      'codeinsight.config.json', '.gitignore', 'sub/.gitattributes', '.github/workflows/ci.yml', 'pkg/.github/workflows/x.yaml', '.github/actions/a/action.yml',
      '.gitlab-ci.yml', '.claude/settings.json', '.claude/hooks/pre.sh', '.Claude/Settings.local.json', '.vscode/tasks.json', '.vscode/settings.json',
      '.envrc', 'package.json', 'web/package.json', 'Makefile', 'GNUmakefile', '.pre-commit-config.yaml', 'pyproject.toml', 'setup.py', '.devcontainer/devcontainer.json',
    ]) expect(isSensitivePath(p), p).toBe(true);
    for (const p of ['src/app.py', '.github/README.md', '.vscode/extensions.json', 'docs/package.json.md', 'workflows/ci.yml', 'claude/settings.json', 'notes/Makefile.txt']) {
      expect(isSensitivePath(p), p).toBe(false);
    }
  });
});
