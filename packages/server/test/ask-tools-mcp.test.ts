import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ASK_TOOLS, buildSnapshot, resetCliShutdown, runAskTool, TOOL_LIMIT_RESULT, truncateToolResult } from '@codeinsight/core';
import type { AskEvent, AskToolContext, ChatMessageInfo } from '@codeinsight/core';
import { askToolContext, startHttpServer, type RunningHttpServer, type ServerWorkspace } from '../src/index.js';
import { apiFor, indexReady, openWorkspace, postStream, shopRepo, tempDir, waitFor, type Api } from './helpers/env.js';
import { tempHomeEnv } from './setup-home.js';

const ASK_TOOLS_HELPER = path.join(import.meta.dirname, 'helpers', 'ask-tools-mcp.mjs');
const FAKE_CLAUDE_MCP = path.join(import.meta.dirname, 'helpers', 'fake-claude-mcp.mjs');

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

const text = (r: unknown) => (r as ToolResult).content.map((c) => c.text).join('\n');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let repo: string;
let dataDir: string;
let ws: ServerWorkspace;
let snapshotId: number;
const clients: Client[] = [];

beforeAll(async () => {
  process.env.CODEINSIGHT_LOG = 'silent';
  repo = shopRepo();
  dataDir = tempDir('ci-ask-tools-');
  ws = await openWorkspace(repo, dataDir);
  snapshotId = (await buildSnapshot({ repo, store: ws.store, layout: ws.layout, config: ws.config })).snapshot.id;
});

afterAll(async () => {
  for (const c of clients) await c.close();
  ws.store.close();
});

async function connect(extra: string[] = []): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ASK_TOOLS_HELPER, '--repo', repo, '--data-dir', dataDir, '--snapshot', String(snapshotId), ...extra],
    env: { PATH: process.env.PATH ?? '', CODEINSIGHT_LOG: 'silent', ...tempHomeEnv() },
  });
  const client = new Client({ name: 'codeinsight-test', version: '0.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

function ctx(sendSource = true): AskToolContext {
  return askToolContext(ws, snapshotId, sendSource);
}

describe('codeinsight mcp --ask-tools', () => {
  it('lists exactly the 7 ask tools with the ASK_TOOLS schemas, marked read-only', async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((t) => t.name)).toEqual(ASK_TOOLS.map((t) => t.name));
    for (const t of tools) {
      expect(t.inputSchema).toEqual(ASK_TOOLS.find((a) => a.name === t.name)!.inputSchema);
      expect(t.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    }
  });

  it('search_symbols and read_source return the same text as runAskTool', async () => {
    const client = await connect();
    const search = await client.callTool({ name: 'search_symbols', arguments: { query: 'refund' } });
    const direct = await runAskTool(ctx(), 'search_symbols', { query: 'refund' });
    expect(text(search)).toBe(truncateToolResult(direct.content));
    const id = /^(\S+) function refund @ app\/orders\/service\.py:/m.exec(direct.content)![1]!;
    const read = await client.callTool({ name: 'read_source', arguments: { id } });
    expect(text(read)).toBe(truncateToolResult((await runAskTool(ctx(), 'read_source', { id })).content));
    expect(text(read)).toContain('def refund');
  });

  it('tool errors come back as isError with the error code text', async () => {
    const r = await (await connect()).callTool({ name: 'get_symbol', arguments: { id: 'no-such-id' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^error: not_found:/);
  });

  it('--no-source: read_source returns no code', async () => {
    const id = /^(\S+) function refund @/m.exec((await runAskTool(ctx(), 'search_symbols', { query: 'refund' })).content)![1]!;
    const r = await (await connect(['--no-source'])).callTool({ name: 'read_source', arguments: { id } });
    expect(text(r)).toBe(truncateToolResult((await runAskTool(ctx(false), 'read_source', { id })).content));
    expect(text(r)).not.toContain('def refund');
  });

  it('after the results pass --max-tool-chars, later calls return the limit text', async () => {
    const client = await connect(['--max-tool-chars', '10']);
    const first = await client.callTool({ name: 'search_symbols', arguments: { query: 'refund' } });
    expect(first.isError).toBeFalsy();
    const second = await client.callTool({ name: 'search_symbols', arguments: { query: 'order' } });
    expect(second.isError).toBe(true);
    expect(text(second)).toBe(TOOL_LIMIT_RESULT);
  });

  it('fails to start with exit code 1 and one stderr line when the snapshot does not exist', async () => {
    const child = spawn(process.execPath, [ASK_TOOLS_HELPER, '--repo', repo, '--data-dir', dataDir, '--snapshot', '999999'], {
      env: { PATH: process.env.PATH ?? '', CODEINSIGHT_LOG: 'silent', ...tempHomeEnv() },
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code).toBe(1);
    expect(stderr).toBe('error: snapshot 999999 does not exist\n');
  });
});

describe('MCP tool calls through the CLI question answering', () => {
  let server: RunningHttpServer;
  let api: Api;
  let recordFile: string;

  const records = (): { pid: number; mcpPid: number }[] =>
    existsSync(recordFile) ? readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { pid: number; mcpPid: number }) : [];

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE_MCP, 0o755);
    resetCliShutdown();
    process.env.CLAUDE_CONFIG_DIR = tempDir('ci-claude-cfg-');
    recordFile = path.join(tempDir('ci-ask-tools-rec-'), 'record.jsonl');
    process.env.FAKE_CLI_RECORD = recordFile;
    const w = await openWorkspace(repo, dataDir, undefined, { CODEINSIGHT_LLM_PROVIDER: 'claude-code', CODEINSIGHT_LLM_COMMAND: FAKE_CLAUDE_MCP });
    server = await startHttpServer({ workspace: w, askToolServer: { command: process.execPath, args: [ASK_TOOLS_HELPER] } });
    api = apiFor(server);
    await indexReady(api);
  });

  afterAll(async () => {
    await server?.close();
    delete process.env.FAKE_CLI_SCENARIO;
  });

  async function newSession(): Promise<number> {
    return (await api<{ id: number }>('/api/chat/sessions', { method: 'POST', body: {} })).body.id;
  }

  it('streams tool / tool_done from the real ask-tools service, saves the answer with refs and leaves no MCP process', async () => {
    process.env.FAKE_CLI_SCENARIO = 'mcp';
    const sessionId = await newSession();
    const s = await postStream(server, `/api/chat/sessions/${sessionId}/messages`, { question: '退款流程怎么走？' });
    await s.ended;
    const events = s.lines.map((l) => JSON.parse(l) as AskEvent);
    const kinds = events.filter((e) => e.type !== 'text').map((e) => (e.type === 'tool' || e.type === 'tool_done' ? `${e.type}:${e.name}` : e.type));
    expect(kinds).toEqual(['start', 'tool:search_symbols', 'tool_done:search_symbols', 'tool:read_source', 'tool_done:read_source', 'done']);
    const done = events.at(-1) as Extract<AskEvent, { type: 'done' }>;
    expect(done.status).toBe('done');
    expect(Object.values(done.refs).map((r) => r.qualifiedName)).toContain('refund');
    expect(done.usage).toEqual({ inputTokens: 30, outputTokens: 9, costUsd: 0.002 });
    const msgs = (await api<{ messages: ChatMessageInfo[] }>(`/api/chat/sessions/${sessionId}`)).body.messages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1]!.content).toBe('退款由 orders 的 refund 处理。');
    expect(msgs[1]!.meta?.toolCalls.map((c) => c.name)).toEqual(['search_symbols', 'read_source']);
    const rec = records().at(-1)!;
    await waitFor(async () => (!alive(rec.pid) && !alive(rec.mcpPid) ? true : undefined), 10_000);
  });

  it('a client disconnect ends the CLI process and its MCP service, and saves the answer as cancelled', async () => {
    process.env.FAKE_CLI_SCENARIO = 'mcp-hang';
    const before = records().length;
    const sessionId = await newSession();
    const s = await postStream(server, `/api/chat/sessions/${sessionId}/messages`, { question: '退款流程怎么走？' });
    await waitFor(async () => (s.lines.some((l) => (JSON.parse(l) as AskEvent).type === 'tool_done' && l.includes('read_source')) ? true : undefined), 30_000);
    const rec = records()[before]!;
    expect(alive(rec.mcpPid)).toBe(true);
    s.destroy();
    await waitFor(async () => (!alive(rec.pid) && !alive(rec.mcpPid) ? true : undefined), 10_000);
    const view = await waitFor(async () => {
      const b = (await api<{ answering: boolean; messages: ChatMessageInfo[] }>(`/api/chat/sessions/${sessionId}`)).body;
      return b.answering ? undefined : b;
    }, 10_000);
    expect(view.messages[1]!.meta?.status).toBe('cancelled');
  });
});
