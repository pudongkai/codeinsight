import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startServe } from '../src/commands/serve.js';
import { tempHomeEnv } from './setup-home.js';

const MAIN = path.resolve(import.meta.dirname, '..', 'dist', 'main.js');

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function makeRepo(): string {
  const repo = tempDir('ci-serve-repo-');
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'], { env });
  writeFileSync(path.join(repo, 'a.py'), 'def a():\n    return b()\n\n\ndef b():\n    return 1\n');
  execFileSync('git', ['-C', repo, 'add', '-A'], { env });
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { env });
  return repo;
}

beforeAll(() => {
  process.env.CODEINSIGHT_LOG = 'silent';
  for (const k of ['CODEINSIGHT_LLM_PROVIDER', 'CODEINSIGHT_LLM_MODEL', 'CODEINSIGHT_LLM_API_KEY', 'CODEINSIGHT_LLM_BASE_URL', 'CODEINSIGHT_DATA_DIR']) delete process.env[k];
});

afterEach(() => vi.restoreAllMocks());

describe('codeinsight serve', () => {
  it('prints port, token, url, repo and dataDir as one JSON line, and --open hands the url to the browser opener', async () => {
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((out += String(chunk)), true));
    const opened: string[] = [];
    const repo = makeRepo();
    const dataDir = tempDir('ci-serve-data-');
    const started = await startServe(['--repo', path.join(repo, '.'), '--data-dir', dataDir, '--open'], {
      openUrl: (url) => opened.push(url),
      staticDir: tempDir('ci-serve-web-'),
    });
    vi.restoreAllMocks();
    try {
      const line = JSON.parse(out.trim().split('\n')[0]!) as { port: number; token: string; url: string; repo: string; dataDir: string };
      expect(line.repo).toBe(realpathSync(repo));
      expect(line.dataDir).toBe(dataDir);
      expect(line.url).toBe(`http://127.0.0.1:${line.port}/?token=${line.token}`);
      expect(opened).toEqual([line.url]);
      const res = await fetch(`http://127.0.0.1:${line.port}/api/status`, { headers: { Authorization: `Bearer ${line.token}` } });
      expect(res.status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${line.port}/api/status`)).status).toBe(401);
    } finally {
      await started!.stop();
    }
  });

  it('reports the data directory actually used, including CODEINSIGHT_DATA_DIR overrides, and the git root for a subdirectory', async () => {
    const repo = makeRepo();
    const sub = path.join(repo, 'sub');
    mkdirSync(sub);
    process.env.CODEINSIGHT_DATA_DIR = 'build/ci-data';
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((out += String(chunk)), true));
    let started: Awaited<ReturnType<typeof startServe>>;
    try {
      started = await startServe(['--repo', sub], { staticDir: tempDir('ci-serve-web-') });
    } finally {
      delete process.env.CODEINSIGHT_DATA_DIR;
      vi.restoreAllMocks();
    }
    try {
      const line = JSON.parse(out.trim().split('\n')[0]!) as { repo: string; dataDir: string };
      expect(line.repo).toBe(realpathSync(repo));
      expect(line.dataDir).toBe(path.join(realpathSync(repo), 'build', 'ci-data'));
    } finally {
      await started!.stop();
    }
  });

  it('without --repo opens the git repository of the current directory, same as --repo .', async () => {
    const repo = makeRepo();
    const sub = path.join(repo, 'sub');
    mkdirSync(sub);
    const lines: { repo: string | null; dataDir: string | null }[] = [];
    for (const argv of [[], ['--repo', '.']]) {
      let out = '';
      vi.spyOn(process, 'cwd').mockReturnValue(sub);
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((out += String(chunk)), true));
      const started = await startServe(argv, { staticDir: tempDir('ci-serve-web-') });
      vi.restoreAllMocks();
      await started!.stop();
      lines.push(JSON.parse(out.trim().split('\n')[0]!) as { repo: string; dataDir: string });
    }
    expect(lines[0]).toEqual({ ...lines[0], repo: realpathSync(repo), dataDir: path.join(realpathSync(repo), '.codeinsight') });
    expect(lines[1]).toMatchObject({ repo: lines[0]!.repo, dataDir: lines[0]!.dataDir });
  });

  it('starts without a repository when the current directory is not in a git repository', async () => {
    const dir = tempDir('ci-serve-plain-');
    let out = '';
    let err = '';
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((out += String(chunk)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => ((err += String(chunk)), true));
    let started: Awaited<ReturnType<typeof startServe>>;
    try {
      started = await startServe([], { staticDir: tempDir('ci-serve-web-') });
    } finally {
      vi.restoreAllMocks();
    }
    try {
      const line = JSON.parse(out.trim().split('\n')[0]!) as { port: number; token: string; repo: string | null; dataDir: string | null };
      expect(line).toMatchObject({ repo: null, dataDir: null });
      expect(err).toContain(`no git repository at ${dir}; choose one in the web UI`);
      const res = await fetch(`http://127.0.0.1:${line.port}/api/status`, { headers: { Authorization: `Bearer ${line.token}` } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ repo: null, repoGen: null, repoLocked: false });
    } finally {
      await started!.stop();
    }
  });

  it('--lock-repo needs a repository and is reported in /api/status', async () => {
    const dir = tempDir('ci-serve-plain-');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(startServe(['--lock-repo'])).rejects.toThrow(/--lock-repo/);
    vi.restoreAllMocks();

    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((out += String(chunk)), true));
    const started = await startServe(['--repo', makeRepo(), '--lock-repo', '--data-dir', tempDir('ci-serve-data-')], { staticDir: tempDir('ci-serve-web-') });
    vi.restoreAllMocks();
    try {
      const line = JSON.parse(out.trim().split('\n')[0]!) as { port: number; token: string };
      const res = await fetch(`http://127.0.0.1:${line.port}/api/status`, { headers: { Authorization: `Bearer ${line.token}` } });
      expect(await res.json()).toMatchObject({ repoLocked: true });
    } finally {
      await started!.stop();
    }
  });

  it('as a process without a repository: answers /api/status and exits cleanly on SIGTERM', async () => {
    const child = spawn(process.execPath, [MAIN, 'serve'], {
      cwd: tempDir('ci-serve-plain-'), env: { PATH: process.env.PATH ?? '', CODEINSIGHT_LOG: 'info', ...tempHomeEnv() }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
    try {
      while (!stdout.includes('\n')) await new Promise((r) => setTimeout(r, 50));
      const line = JSON.parse(stdout.split('\n')[0]!) as { port: number; token: string; repo: string | null; dataDir: string | null };
      expect(line).toMatchObject({ repo: null, dataDir: null });
      const res = await fetch(`http://127.0.0.1:${line.port}/api/status`, { headers: { Authorization: `Bearer ${line.token}` } });
      expect(await res.json()).toMatchObject({ repo: null });
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  it('rejects an invalid --port', async () => {
    await expect(startServe(['--port', 'abc'])).rejects.toThrow(/--port/);
  });
});
