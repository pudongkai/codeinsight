import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { initDataDir, Store } from '@codeinsight/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Resolver } from '@codeinsight/core';
import { createMcpServer } from '../src/index.js';
import { fixtureRepo, openWorkspace, tempDir, writeFiles } from './helpers/env.js';
import { tempHomeEnv } from './setup-home.js';

const HELPER = path.join(import.meta.dirname, 'helpers', 'mcp-stdio.mjs');
const FAKE_SCIP = path.resolve(import.meta.dirname, '..', '..', 'core', 'test', 'helpers', 'fake-scip.mjs');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

function text(r: unknown): string {
  return (r as ToolResult).content.map((c) => c.text).join('\n');
}

describe('MCP over stdio', () => {
  let client: Client;
  let stderr = '';
  let repo: string;

  beforeAll(async () => {
    repo = fixtureRepo();
    // 未提交的改动，供 review_changes 默认审查工作区
    writeFiles(repo, { 'pkg/repo.py': 'import os\n\n\ndef f(x):\n    """Join a path."""\n    return os.path.join("b", str(x))\n\n\ndef g():\n    return f(1)\n\n\ndef rec(n):\n    return rec(n - 1) if n else 0\n\n\nclass Base:\n    pass\n' });
    // 子进程只拿到 PATH 和临时用户目录，不会读到本机的 LLM 配置、API key 和用户设置
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [HELPER, repo, tempDir('ci-mcp-data-')],
      env: { PATH: process.env.PATH ?? '', CODEINSIGHT_LOG: 'info', ...tempHomeEnv() },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    client = new Client({ name: 'codeinsight-test', version: '0.0.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
  });

  it('lists the review tools and get_overview', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['find_similar', 'get_impact', 'get_overview', 'review_changes']);
  });

  it('get_impact builds the index first, then lists callers by level', async () => {
    const r = await client.callTool({ name: 'get_impact', arguments: { symbol: 'f' } });
    expect(r.isError).toBeFalsy();
    const t = text(r);
    expect(t).toContain('# Impact of `f` (pkg/repo.py:4)');
    expect(t).toContain('## Level 1');
    expect(t).toMatch(/### Production[\s\S]*`g`/);
    expect(t).toMatch(/### Test[\s\S]*`test_f`/);
    expect(stderr).toContain('index_job_start');
  });

  it('get_impact returns candidates for a name with two definitions, and accepts a key', async () => {
    const r = await client.callTool({ name: 'get_impact', arguments: { symbol: 'dup' } });
    expect(r.isError).toBeFalsy();
    const t = text(r);
    expect(t).toContain('Multiple symbols match `dup`');
    expect(t).toContain('`pkg/service.py#function#dup#`');
    expect(t).toContain('`pkg/service.py#function#dup#2#`');
    const byKey = text(await client.callTool({ name: 'get_impact', arguments: { symbol: 'pkg/service.py#function#dup#2#', depth: 1 } }));
    expect(byKey).toContain('`use_dup`');
    const missing = await client.callTool({ name: 'get_impact', arguments: { symbol: 'no_such_function' } });
    expect(missing.isError).toBe(true);
  });

  it('find_similar accepts a code snippet or a symbol', async () => {
    const code = await client.callTool({ name: 'find_similar', arguments: { code: 'def register(cb=None):\n    return cb\n' } });
    expect(code.isError).toBeFalsy();
    expect(text(code)).toMatch(/`register` at pkg\/service\.py:\d+ .*same-name duplicate/);
    const sym = await client.callTool({ name: 'find_similar', arguments: { symbol: 'pkg/extra.py#function#register#' } });
    expect(text(sym)).toContain('pkg/service.py');
    const ambiguous = await client.callTool({ name: 'find_similar', arguments: { symbol: 'register' } });
    expect(text(ambiguous)).toContain('Multiple symbols match `register`');
    const both = await client.callTool({ name: 'find_similar', arguments: {} });
    expect(both.isError).toBe(true);
  });

  it('review_changes returns a Markdown report of the working tree changes', async () => {
    const r = await client.callTool({ name: 'review_changes', arguments: {} });
    expect(r.isError).toBeFalsy();
    const t = text(r);
    expect(t).toContain('# CodeInsight review');
    expect(t).toMatch(/\| modified \| `f` \|/);
    const range = text(await client.callTool({ name: 'review_changes', arguments: { head: 'HEAD' } }));
    expect(range).toMatch(/\| added \| `h` \|/);
  });
});

describe('MCP index timeout', () => {
  const prevLevel = process.env.CODEINSIGHT_LOG;
  beforeAll(() => {
    process.env.CODEINSIGHT_LOG = 'silent';
  });
  afterAll(() => {
    if (prevLevel === undefined) delete process.env.CODEINSIGHT_LOG;
    else process.env.CODEINSIGHT_LOG = prevLevel;
  });

  it('returns an error instead of an empty result when indexing does not finish in time', async () => {
    const hanging: Resolver = { name: 'hanging', resolve: () => new Promise(() => undefined) };
    const ws = await openWorkspace(fixtureRepo(), tempDir('ci-mcp-timeout-'), hanging);
    const server = createMcpServer({ workspace: ws, indexTimeoutMs: 300 });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'codeinsight-test', version: '0.0.0' });
    await client.connect(clientSide);
    try {
      const r = await client.callTool({ name: 'get_impact', arguments: { symbol: 'f' } });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('did not finish within');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('MCP shutdown while indexing', () => {
  it('kills scip-python, waits for the index job and leaves no pending snapshot when the client disconnects', async () => {
    const dataDir = tempDir('ci-mcp-close-');
    const pidFile = path.join(tempDir('ci-mcp-pid-'), 'pid');
    const child = spawn(process.execPath, [HELPER, fixtureRepo(), dataDir, FAKE_SCIP], {
      env: { PATH: process.env.PATH ?? '', FAKE_SCIP_PID_FILE: pidFile, CODEINSIGHT_LOG: 'info', ...tempHomeEnv() },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
    const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_impact', arguments: { symbol: 'f' } } });
    const deadline = Date.now() + 30_000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const scipPid = Number(readFileSync(pidFile, 'utf8'));
    expect(alive(scipPid)).toBe(true);
    child.stdin.end();
    expect(await exited).toBe(0);
    expect(alive(scipPid)).toBe(false);
    expect(readdirSync(path.join(dataDir, 'scip')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(stderr).not.toContain('database is not open');
    for (const line of stdout.trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow();
    const store = new Store((await initDataDir(dataDir)).dbPath);
    const snaps = store.listSnapshots();
    store.close();
    expect(snaps.length).toBeGreaterThan(0);
    expect(snaps.map((s) => s.resolverStatus)).toEqual(snaps.map(() => 'failed'));
  });
});
