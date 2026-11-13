import { existsSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { AddDirError, MAX_ADD_DIRS, ReviewArgsError, resolveAddDirs, resolveWriteRoot, WriteNotAllowedError, writeScopeView } from '../src/index.js';
import type { AddDirCheckOptions } from '../src/index.js';
import { git, tempDir } from './helpers/git-repo.js';

let home: string;
let ciHome: string;
let sys: string;
let repo: string;
let opts: AddDirCheckOptions;

beforeAll(() => {
  process.env.CODEINSIGHT_LOG = 'silent';
  home = realpathSync(tempDir('ci-wroots-home-'));
  for (const d of ['.ssh', '.config/app', 'Library/Preferences', 'projects/notes', 'projects/docs', 'projects/.codeinsight', 'ci-home/sub']) {
    mkdirSync(path.join(home, d), { recursive: true });
  }
  ciHome = path.join(home, 'ci-home');
  sys = realpathSync(tempDir('ci-wroots-sys-'));
  mkdirSync(path.join(sys, 'lib'));
  repo = path.join(home, 'projects', 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  // /etc 在 macOS 上的真实路径是 /private/etc，名单里只给 /etc 也要能挡住
  opts = { home, codeinsightHome: ciHome, systemDirs: [sys, '/etc'] };
});

async function addDirError(dirs: string[]): Promise<string> {
  const err = await resolveAddDirs(dirs, opts).then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(AddDirError);
  expect(err).toBeInstanceOf(ReviewArgsError);
  return (err as Error).message;
}

describe('resolveAddDirs', () => {
  it('returns real paths in argument order, without duplicates', async () => {
    const notes = path.join(home, 'projects', 'notes');
    const link = path.join(home, 'projects', 'notes-link');
    symlinkSync(notes, link);
    const dirs = await resolveAddDirs([notes, path.join(home, 'projects', 'docs'), link, `${notes}/`], opts);
    expect(dirs).toEqual([notes, path.join(home, 'projects', 'docs')]);
    expect(await resolveAddDirs([], opts)).toEqual([]);
  });

  it('rejects the file system root, the home directory and system directories', async () => {
    expect(await addDirError(['/'])).toContain('root');
    expect(await addDirError([home])).toContain('home directory');
    expect(await addDirError([path.dirname(home)])).toContain('directories containing it');
    expect(await addDirError([sys])).toContain('system directories');
    expect(await addDirError([path.join(sys, 'lib')])).toContain('system directories');
    expect(await addDirError(['/etc'])).toContain('system directories');
  });

  it('rejects hidden directories and Library under the home directory', async () => {
    expect(await addDirError([path.join(home, '.ssh')])).toContain('hidden');
    expect(await addDirError([path.join(home, '.config', 'app')])).toContain('hidden');
    expect(await addDirError([path.join(home, 'Library', 'Preferences')])).toContain('Library');
  });

  it('rejects CODEINSIGHT_HOME, .codeinsight and .git directories and anything inside them', async () => {
    expect(await addDirError([ciHome])).toContain('settings directory');
    expect(await addDirError([path.join(ciHome, 'sub')])).toContain('settings directory');
    expect(await addDirError([path.join(home, 'projects', '.codeinsight')])).toContain('.codeinsight');
    expect(await addDirError([path.join(repo, '.git')])).toContain('.git');
    expect(await addDirError([path.join(repo, '.git', 'hooks')])).toContain('.git');
  });

  it('rejects directories containing the real home directory, such as /Users', async () => {
    const parents = [path.dirname(os.homedir()), ...(existsSync('/Users') ? ['/Users'] : [])];
    for (const dir of parents) {
      const err = await resolveAddDirs([dir], { systemDirs: [] }).then(() => undefined, (e: unknown) => e);
      expect(err, dir).toBeInstanceOf(AddDirError);
      expect((err as Error).message).toMatch(/directories containing|system directories|root/);
    }
  });

  it('rejects directories containing CODEINSIGHT_HOME', async () => {
    const box = realpathSync(tempDir('ci-wroots-box-'));
    const ci = path.join(box, 'ci');
    mkdirSync(ci);
    const err = await resolveAddDirs([box], { ...opts, codeinsightHome: ci }).then(() => undefined, (e: unknown) => e);
    expect((err as Error).message).toContain('containing the CodeInsight settings directory');
  });

  it('rejects missing directories and files', async () => {
    expect(await addDirError([path.join(home, 'nope')])).toContain('not an existing directory');
  });

  it(`accepts at most ${MAX_ADD_DIRS} directories`, async () => {
    const many = Array.from({ length: MAX_ADD_DIRS + 1 }, (_, i) => {
      const d = path.join(home, 'many', `d${i}`);
      mkdirSync(d, { recursive: true });
      return d;
    });
    expect(await resolveAddDirs(many.slice(0, MAX_ADD_DIRS), opts)).toHaveLength(MAX_ADD_DIRS);
    expect(await addDirError(many)).toContain(`at most ${MAX_ADD_DIRS}`);
  });
});

describe('write roots', () => {
  const dirs = ['/x/notes', '/y/docs'];

  it('maps repo and dir1..dirN to directories; repo follows the current repository', () => {
    expect(resolveWriteRoot(undefined, '/repo-a', dirs)).toEqual({ name: 'repo', path: '/repo-a', repo: true });
    expect(resolveWriteRoot('repo', '/repo-b', dirs)).toEqual({ name: 'repo', path: '/repo-b', repo: true });
    expect(resolveWriteRoot('dir2', '/repo-a', dirs)).toEqual({ name: 'dir2', path: '/y/docs', repo: false });
  });

  it('rejects unknown root names and lists the available ones', () => {
    expect(() => resolveWriteRoot('dir3', '/repo', dirs)).toThrow(WriteNotAllowedError);
    expect(() => resolveWriteRoot('dir1', '/repo', [])).toThrow('writable roots: repo');
    expect(() => resolveWriteRoot('/x/notes', '/repo', dirs)).toThrow('writable roots: repo, dir1, dir2');
  });

  it('the status view only has directory names', () => {
    expect(writeScopeView(dirs)).toEqual({ repo: true, dirs: ['notes', 'docs'] });
    expect(writeScopeView([], false)).toEqual({ repo: false, dirs: [] });
  });
});
