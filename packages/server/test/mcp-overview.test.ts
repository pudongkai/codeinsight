import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildSnapshot, partitionRecordPath, runOverview } from '@codeinsight/core';
import type { OverviewReport } from '@codeinsight/core';
import { createMcpServer, type ServerWorkspace } from '../src/index.js';
import { MAX_OVERVIEW_CHARS } from '../src/mcp/overview-tool.js';
import { fakeLlmEnv, overviewReply, startFakeLlm, type FakeLlm } from '../../core/test/helpers/fake-llm-server.mjs';
import { openWorkspace, shopRepo, tempDir, writeFiles } from './helpers/env.js';

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

const prevLevel = process.env.CODEINSIGHT_LOG;
let fake: FakeLlm;
let repo: string;
let ws: ServerWorkspace;
let server: McpServer;
let client: Client;

async function getOverview(args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const r = (await client.callTool({ name: 'get_overview', arguments: args })) as ToolResult;
  return { text: r.content.map((c) => c.text).join('\n'), isError: r.isError === true };
}

/** 模块表里的第一个模块 id */
function firstModuleId(md: string): string {
  const m = /^\| [^|]+ \| `([^`]+)` \|/m.exec(md);
  if (!m) throw new Error('no module table');
  return m[1]!;
}

beforeAll(async () => {
  process.env.CODEINSIGHT_LOG = 'silent';
  fake = await startFakeLlm({ reply: overviewReply });
  repo = shopRepo();
  ws = await openWorkspace(repo, tempDir('ci-mcp-ov-'), undefined, fakeLlmEnv(fake.url));
  server = createMcpServer({ workspace: ws });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'codeinsight-test', version: '0.0.0' });
  await client.connect(clientSide);
});

afterAll(async () => {
  await client?.close();
  await server?.close();
  ws?.store.close();
  await fake?.close();
  if (prevLevel === undefined) delete process.env.CODEINSIGHT_LOG;
  else process.env.CODEINSIGHT_LOG = prevLevel;
});

describe('MCP get_overview', () => {
  it('without a saved overview returns the structure only, sends no LLM request and writes no partition record', async () => {
    const r = await getOverview();
    expect(r.isError).toBe(false);
    expect(r.text).toContain('## 模块');
    expect(r.text).toContain('AI 说明：无');
    expect(r.text).toContain('运行 `codeinsight overview` 可加上 AI 生成的说明');
    expect(fake.requests).toHaveLength(0);
    expect(existsSync(partitionRecordPath(ws.config.dataDir))).toBe(false);
    expect(ws.store.overviews.list()).toEqual([]);
  });

  it('looks up one module by id and reports unknown modules', async () => {
    const id = firstModuleId((await getOverview()).text);
    const r = await getOverview({ module: id });
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`（\`${id}\`）`);
    const missing = await getOverview({ module: 'no/such/module' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain(`\`${id}\``);
    expect(fake.requests).toHaveLength(0);
  });

  it('returns the saved overview with AI descriptions, by module name too', async () => {
    const { repo: r, store, layout, config } = ws;
    const { snapshot } = await buildSnapshot({ repo: r, store, layout, config });
    const { report } = await runOverview({ repo: r, store, layout, config, snapshot, ref: 'working' });
    const before = fake.requests.length;
    const all = await getOverview();
    expect(all.text).toMatch(/^# 系统简介/);
    expect(all.text).not.toContain('codeinsight overview');
    expect(all.text).not.toContain('代码已有变化');
    const m = report.modules[0]!;
    const one = await getOverview({ module: m.name });
    expect(one.text).toContain(`## ${m.name}（\`${m.id}\`）`);
    expect(fake.requests.length).toBe(before);
  });

  /** 把 report 保存成一条新的 done 记录（成为当前概览） */
  function saveOverview(report: OverviewReport): void {
    const row = ws.store.overviews.current().overview!;
    const r = ws.store.overviews.begin({ ref: 'working', snapshotKind: 'working', commitSha: row.commitSha, contentKey: row.contentKey, params: row.params });
    if (!r.ok) throw new Error('overview running');
    ws.store.overviews.finish(r.id, report, true);
  }

  it('with many modules lists only the first ones and keeps features and boundary issues', async () => {
    const base = ws.store.overviews.current().overview!.result!;
    const big = structuredClone(base);
    const template = big.modules[0]!;
    big.modules = Array.from({ length: 800 }, (_, i) => ({ ...template, id: `pkg/m${i}`, name: `模块${i}`, responsibility: '负责'.repeat(20) }));
    big.features = [{ ...big.features[0]!, name: '最后的功能' }];
    big.issues = [{ kind: 'cycle', severity: 'warning', modules: ['pkg/m1', 'pkg/m2'], message: '最后的边界问题', samples: [] }];
    saveOverview(big);
    const t = (await getOverview()).text;
    expect(t.length).toBeLessThanOrEqual(MAX_OVERVIEW_CHARS);
    const omitted = /其余 (\d+) 个模块未列出，用 `module` 参数/.exec(t);
    expect(Number(omitted?.[1])).toBeGreaterThan(0);
    expect(t).toContain('| 模块0 | `pkg/m0` |');
    expect(t).not.toContain('`pkg/m799`');
    expect(t).toContain('## 功能');
    expect(t).toContain('最后的功能');
    expect(t).toContain('## 边界问题');
    expect(t).toContain('最后的边界问题');
    expect(t).not.toContain('内容过长已截断');
    // 每一行都是完整的表格行或普通行，没有截在行中间
    for (const line of t.split('\n').filter((l) => l.startsWith('| 模块'))) expect(line.endsWith('|')).toBe(true);
    expect((await getOverview({ module: 'pkg/m799' })).text).toContain('（`pkg/m799`）');
  });

  it('cuts at a line boundary when the rest alone is over the limit, and notes when the code has changed', async () => {
    const big = structuredClone(ws.store.overviews.current().overview!.result!);
    big.modules = big.modules.slice(0, 3);
    big.system = { title: '大概览', summary: Array.from({ length: 3000 }, (_, i) => `第 ${i} 行说明文字`).join('\n') };
    saveOverview(big);
    const t = (await getOverview()).text;
    expect(t.length).toBeLessThanOrEqual(MAX_OVERVIEW_CHARS);
    expect(t).toMatch(/\n> 内容过长已截断（共 \d+ 字符）。$/);
    expect(t).toMatch(/\n第 \d+ 行说明文字\n\n> 内容过长/);

    writeFiles(repo, { 'app/tiny/changed.py': 'def changed():\n    return 2\n' });
    const stale = (await getOverview()).text;
    expect(stale).toContain('代码已有变化');
    expect(stale.length).toBeLessThanOrEqual(MAX_OVERVIEW_CHARS);
  });
});
