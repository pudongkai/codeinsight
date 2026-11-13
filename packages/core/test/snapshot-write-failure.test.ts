import { cpSync, existsSync, lstatSync, readFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildSnapshot, initDataDir, loadConfig, snapshotDir, Store } from '../src/index.js';
import type { ResolveInput, ResolveResult, Resolver } from '../src/index.js';
import { ScipPythonResolver } from '../src/index.js';
import { commitAll, git, tempDir, writeFiles } from './helpers/git-repo.js';

/** suffix：写到以它结尾的路径时先写一半再失败；readlinkSuffix：读以它结尾的符号链接时报错 */
const failing: { suffix?: string; readlinkSuffix?: string } = {};

vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>();
  const writeFile: typeof orig.writeFile = async (file, data, options) => {
    if (failing.suffix && typeof file === 'string' && file.endsWith(failing.suffix)) {
      await orig.writeFile(file, Buffer.from(data as Uint8Array).subarray(0, 5));
      throw new Error('disk full');
    }
    return orig.writeFile(file, data, options);
  };
  const readlink = (async (file: string, options?: unknown) => {
    if (failing.readlinkSuffix && typeof file === 'string' && file.endsWith(failing.readlinkSuffix)) {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    }
    return orig.readlink(file, options as never);
  }) as typeof orig.readlink;
  return { ...orig, writeFile, readlink, default: { ...orig, writeFile, readlink } };
});

class CountingResolver implements Resolver {
  readonly name = 'counting';
  calls = 0;
  private readonly inner = new ScipPythonResolver();
  resolve(input: ResolveInput): Promise<ResolveResult> {
    this.calls++;
    return this.inner.resolve(input);
  }
}

describe('snapshot file write failure', () => {
  it('removes the partial file and neither links it nor reuses edges from that snapshot', async () => {
    const repo = tempDir('ci-incr-wf-');
    cpSync(path.join(import.meta.dirname, 'fixtures', 'py-basic'), repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    commitAll(repo, 'init');
    const config = await loadConfig(repo, { dataDir: tempDir('ci-incr-wf-data-'), env: {} });
    const layout = await initDataDir(config.dataDir);
    const store = new Store(layout.dbPath);
    const resolver = new CountingResolver();
    const build = () => buildSnapshot({ repo, store, layout, config, resolver });

    failing.suffix = path.join('pkg', 'repo.py');
    const first = await build();
    failing.suffix = undefined;
    const dir1 = snapshotDir(layout, first.snapshot.contentKey);
    expect(existsSync(path.join(dir1, 'pkg/repo.py'))).toBe(false);
    expect(resolver.calls).toBe(1);

    writeFiles(repo, { 'README.md': '# changed\n' });
    const second = await build();
    const dir2 = snapshotDir(layout, second.snapshot.contentKey);
    expect(readFileSync(path.join(dir2, 'pkg/repo.py'), 'utf8')).toBe(readFileSync(path.join(repo, 'pkg/repo.py'), 'utf8'));
    expect(resolver.calls).toBe(2);
    store.close();
  }, 120_000);

  it('skips a symlink whose target cannot be read instead of failing the build', async () => {
    const repo = tempDir('ci-incr-rl-');
    cpSync(path.join(import.meta.dirname, 'fixtures', 'py-basic'), repo, { recursive: true });
    symlinkSync('repo.py', path.join(repo, 'pkg', 'gone_link.py'));
    git(repo, 'init', '-q', '-b', 'main');
    commitAll(repo, 'init');
    const config = await loadConfig(repo, { dataDir: tempDir('ci-incr-rl-data-'), env: {} });
    const layout = await initDataDir(config.dataDir);
    const store = new Store(layout.dbPath);
    failing.readlinkSuffix = path.join('pkg', 'gone_link.py');
    try {
      const { snapshot } = await buildSnapshot({ repo, store, layout, config, resolver: new ScipPythonResolver() });
      const dir = snapshotDir(layout, snapshot.contentKey);
      expect(() => lstatSync(path.join(dir, 'pkg/gone_link.py'))).toThrow();
      expect(store.getFiles(snapshot.id).map((f) => f.path)).not.toContain('pkg/gone_link.py');
      expect(existsSync(path.join(dir, 'pkg/repo.py'))).toBe(true);
    } finally {
      failing.readlinkSuffix = undefined;
      store.close();
    }
  }, 120_000);
});
