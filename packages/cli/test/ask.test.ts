import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { fakeLlmEnv, startFakeLlm, toolResults, type FakeLlm, type FakeLlmReply, type FakeLlmRequest } from '../../core/test/helpers/fake-llm-server.mjs';
import { commitAll, git } from '../../core/test/helpers/git-repo.js';

const FIXTURE = path.resolve(import.meta.dirname, '..', '..', 'core', 'test', 'fixtures', 'py-shop');
const LLM_VARS = ['CODEINSIGHT_LLM_PROVIDER', 'CODEINSIGHT_LLM_MODEL', 'CODEINSIGHT_LLM_API_KEY', 'CODEINSIGHT_LLM_BASE_URL'];

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function shopRepo(): string {
  const repo = tempDir('ci-cli-ask-');
  cpSync(FIXTURE, repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  commitAll(repo, 'init');
  return repo;
}

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((out += String(chunk)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => ((err += String(chunk)), true));
  try {
    return { code: await runCli(argv), out, err };
  } finally {
    vi.restoreAllMocks();
  }
}

/** 结果行 `<id> <kind> <qualifiedName> @ <path>:...` 里 refund 的 id */
function refundId(text: string): string | undefined {
  return /^(\S+) function refund @ app\/orders\/service\.py:/m.exec(text)?.[1];
}

/** 搜索 refund → 读它的源码 → 回答 */
function reply(req: FakeLlmRequest): FakeLlmReply {
  const results = toolResults(req);
  if (results.length === 0) return { toolCalls: [{ name: 'search_symbols', input: { query: 'refund' } }] };
  if (results.length === 1) return { toolCalls: [{ name: 'read_source', input: { id: refundId(results[0]!) } }] };
  return { text: '退款由 orders 的 refund 处理。' };
}

let fake: FakeLlm;
beforeAll(async () => {
  process.env.CODEINSIGHT_LOG = 'silent';
  for (const k of [...LLM_VARS, 'CODEINSIGHT_DATA_DIR', 'CODEINSIGHT_SEND_SOURCE']) delete process.env[k];
  fake = await startFakeLlm({ reply });
  Object.assign(process.env, fakeLlmEnv(fake.url));
});
afterAll(() => fake.close());
afterEach(() => vi.restoreAllMocks());

describe('codeinsight ask', () => {
  const repo = shopRepo();
  const dataDir = tempDir('ci-cli-ask-data-');
  const args = ['--repo', repo, '--data-dir', dataDir];

  it('streams the answer to stdout and tool calls to stderr', async () => {
    const before = fake.requests.length;
    const r = await cli('ask', '退款流程怎么走？', ...args);
    expect(r.code).toBe(0);
    expect(r.out).toBe('退款由 orders 的 refund 处理。\n');
    expect(r.err).toContain('[tool] search_symbols query="refund"');
    expect(r.err).toContain('[tool] read_source id=');
    expect(r.err).toContain('sending the question and related code to anthropic');
    const sent = fake.requests.slice(before);
    expect(sent).toHaveLength(3);
    expect(toolResults(sent[2]!)[1]).toContain('payments.refund_payment(order_id, order["total"])');
  });

  it('--no-source sends no function bodies', async () => {
    const before = fake.requests.length;
    const r = await cli('ask', '退款流程怎么走？', '--no-source', ...args);
    expect(r.code).toBe(0);
    const sent = fake.requests.slice(before);
    const results = toolResults(sent[2]!).join('\n');
    expect(results).toMatch(/function refund @ app\/orders\/service\.py:17-20 \| sig: \(order_id: int\) -> dict/);
    expect(results).not.toContain('refund_payment(order_id, order["total"])');
    expect(results).not.toContain('repository.load_order');
    expect(JSON.stringify(sent[0]!.body.system)).toContain('Source sending is turned off');
  });

  it('exits with 1 and explains how to configure an LLM when none is configured', async () => {
    const saved = Object.fromEntries(LLM_VARS.map((k) => [k, process.env[k]]));
    for (const k of LLM_VARS) delete process.env[k];
    try {
      const before = fake.requests.length;
      const r = await cli('ask', 'q', ...args);
      expect(r.code).toBe(1);
      expect(r.err).toContain('CODEINSIGHT_LLM_PROVIDER');
      expect(fake.requests.length).toBe(before);
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    }
  });

  it('exits with 1 without a question', async () => {
    expect((await cli('ask', ...args)).code).toBe(1);
  });
});
