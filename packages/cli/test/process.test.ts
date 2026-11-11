import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const MAIN = path.resolve(import.meta.dirname, '..', 'dist', 'main.js');
const SERVE_HELPER = path.join(import.meta.dirname, 'helpers', 'serve-fake-scip.mjs');
const FAKE_SCIP = path.resolve(import.meta.dirname, '..', '..', 'core', 'test', 'helpers', 'fake-scip.mjs');

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function makeRepo(): string {
  const repo = tempDir('ci-proc-repo-');
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'], { env });
  writeFileSync(path.join(repo, 'a.py'), 'def a():\n    return b()\n\n\ndef b():\n    return 1\n');
  execFileSync('git', ['-C', repo, 'add', '-A'], { env });
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { env });
  return repo;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 子进程只拿到 PATH，不会读到本机的 LLM 配置和 API key */
const baseEnv = () => ({ PATH: process.env.PATH ?? '', CODEINSIGHT_LOG: 'info' });

describe('codeinsight serve process', () => {
  it('kills scip-python and removes its temp output on SIGTERM', async () => {
    const dataDir = tempDir('ci-proc-data-');
    const pidFile = path.join(tempDir('ci-proc-pid-'), 'pid');
    const child = spawn(process.execPath, [SERVE_HELPER, FAKE_SCIP, '--repo', makeRepo(), '--data-dir', dataDir], {
      env: { ...baseEnv(), FAKE_SCIP_PID_FILE: pidFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
    try {
      await until(() => existsSync(pidFile) && stdout.includes('\n'));
      expect(JSON.parse(stdout.split('\n')[0]!)).toHaveProperty('token');
      const scipPid = Number(readFileSync(pidFile, 'utf8'));
      const scipDir = path.join(dataDir, 'scip');
      expect(alive(scipPid)).toBe(true);
      expect(readdirSync(scipDir).some((f) => f.endsWith('.tmp'))).toBe(true);
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      await until(() => !alive(scipPid), 5000);
      expect(readdirSync(scipDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});

describe('codeinsight mcp process', () => {
  it('serves a tool over stdio and writes nothing but JSON-RPC to stdout', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MAIN, 'mcp', '--repo', makeRepo(), '--data-dir', tempDir('ci-proc-mcp-')],
      env: baseEnv(),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'codeinsight-test', version: '0.0.0' });
    const errors: Error[] = [];
    client.onerror = (err) => errors.push(err);
    await client.connect(transport);
    try {
      const r = (await client.callTool({ name: 'get_impact', arguments: { symbol: 'b' } })) as { content: { text: string }[]; isError?: boolean };
      expect(r.isError).toBeFalsy();
      expect(r.content[0]!.text).toContain('`a` at a.py:1');
    } finally {
      await client.close();
    }
    // 非 JSON 的 stdout 行会让客户端报解析错误
    expect(errors).toEqual([]);
  });
});
