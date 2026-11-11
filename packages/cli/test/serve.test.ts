import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startServe } from '../src/commands/serve.js';

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
  it('prints port, token and url as one JSON line, and --open hands the url to the browser opener', async () => {
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((out += String(chunk)), true));
    const opened: string[] = [];
    const started = await startServe(['--repo', makeRepo(), '--data-dir', tempDir('ci-serve-data-'), '--open'], {
      openUrl: (url) => opened.push(url),
      staticDir: tempDir('ci-serve-web-'),
    });
    vi.restoreAllMocks();
    try {
      const line = JSON.parse(out.trim().split('\n')[0]!) as { port: number; token: string; url: string };
      expect(line.url).toBe(`http://127.0.0.1:${line.port}/?token=${line.token}`);
      expect(opened).toEqual([line.url]);
      const res = await fetch(`http://127.0.0.1:${line.port}/api/status`, { headers: { Authorization: `Bearer ${line.token}` } });
      expect(res.status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${line.port}/api/status`)).status).toBe(401);
    } finally {
      await started!.stop();
    }
  });

  it('rejects an invalid --port', async () => {
    await expect(startServe(['--port', 'abc'])).rejects.toThrow(/--port/);
  });
});
