import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runAskTool, runOverview, truncateToolResult, MAX_TOOL_RESULT_CHARS } from '../src/index.js';
import type { AskToolContext } from '../src/index.js';
import { askEnv, idOf, toolContext, type AskEnv } from './helpers/ask-env.js';
import { tempDir } from './helpers/git-repo.js';

let env: AskEnv;
let ctx: AskToolContext;
beforeAll(async () => {
  process.env.CODEINSIGHT_LOG = 'silent';
  // 清单里有指向仓库外的符号链接和一个读不了的文件，grep_code 应跳过它们
  const outside = tempDir('ci-ask-outside-');
  writeFileSync(path.join(outside, 'outside.py'), 'def refund_payment(x):\n    pass\n');
  env = await askEnv((repo) => {
    symlinkSync(path.join(outside, 'outside.py'), path.join(repo, 'app', 'outside_link.py'));
    mkdirSync(path.join(repo, 'notes'));
    writeFileSync(path.join(repo, 'notes', 'locked.txt'), 'refund_payment( locked\n');
  });
  chmodSync(path.join(env.repo, 'notes', 'locked.txt'), 0);
  ctx = toolContext(env);
});
afterAll(() => env.store.close());

async function refundId(): Promise<string> {
  const r = await runAskTool(ctx, 'search_symbols', { query: 'refund' });
  return idOf(r.content, 'refund', 'app/orders/service.py')!;
}

describe('symbol tools', () => {
  it('search_symbols lists ids, locations, signatures and entry marks; limit is capped at 20', async () => {
    const r = await runAskTool(ctx, 'search_symbols', { query: 'refund' });
    expect(r.error).toBeUndefined();
    expect(r.content).toMatch(/ function refund @ app\/orders\/service\.py:17-20 \| sig: /);
    expect(r.content).toMatch(/refund_order @ app\/orders\/api\.py:\d+-\d+ .*entry: HTTP POST \/orders\/\{order_id\}\/refund/);
    expect(r.symbols.length).toBeGreaterThanOrEqual(3);
    const many = await runAskTool(ctx, 'search_symbols', { query: '_', limit: 500 });
    expect(many.content.split('\n').length).toBeLessThanOrEqual(20);
  });

  it('get_symbol and get_call_graph work from an id', async () => {
    const id = await refundId();
    const s = await runAskTool(ctx, 'get_symbol', { id });
    expect(s.content).toContain('name: refund');
    expect(s.content).toMatch(/callers: 1, callees: [23]/);
    const g = await runAskTool(ctx, 'get_call_graph', { id, direction: 'callers', depth: 9 });
    expect(g.content).toContain('depth 1:');
    expect(g.content).toContain('refund_order');
  });

  it('invalid arguments and unknown ids come back as error codes', async () => {
    expect((await runAskTool(ctx, 'get_symbol', {})).error).toBe('invalid_args');
    expect((await runAskTool(ctx, 'get_call_graph', { id: 'x', direction: 'up' })).error).toBe('invalid_args');
    expect((await runAskTool(ctx, 'get_symbol', { id: 'nope' })).error).toBe('not_found');
    expect((await runAskTool(ctx, 'no_such_tool', {})).error).toBe('invalid_args');
    expect((await runAskTool(ctx, 'search_symbols', 'refund')).error).toBe('invalid_args');
  });

  it('list_entries filters by kind and path', async () => {
    const r = await runAskTool(ctx, 'list_entries', { kind: 'http', pathContains: 'orders' });
    expect(r.content).toContain('HTTP POST /orders/{order_id}/refund -> ');
    expect(r.content).not.toContain('app/payments');
  });

  it('get_module needs an overview', async () => {
    expect((await runAskTool(ctx, 'get_module', {})).error).toBe('overview_missing');
    const { report } = await runOverview({ ...env, ref: 'working', noLlm: true });
    const withOverview = { ...ctx, overview: report };
    const list = await runAskTool(withOverview, 'get_module', {});
    expect(list.content).toContain('app/orders');
    const one = await runAskTool(withOverview, 'get_module', { module: 'app/orders' });
    expect(one.content).toContain('（`app/orders`）');
    expect((await runAskTool(withOverview, 'get_module', { module: 'nope' })).error).toBe('not_found');
    const s = await runAskTool(withOverview, 'search_symbols', { query: 'refund_payment' });
    expect(s.content).toContain('module: app/payments');
  });
});

describe('read_source and grep_code', () => {
  it('rejects paths outside the snapshot without echoing absolute paths', async () => {
    for (const p of ['../etc/passwd', '/etc/passwd', path.join(env.repo, 'app/main.py'), 'app/../../x.py']) {
      const r = await runAskTool(ctx, 'read_source', { path: p });
      expect(r.error).toBe('path_not_allowed');
      expect(r.content).not.toContain(env.repo);
      expect(r.content).not.toContain('/etc');
    }
    expect((await runAskTool(ctx, 'read_source', { path: 'app/missing.py' })).error).toBe('not_found');
    expect((await runAskTool(ctx, 'read_source', {})).error).toBe('invalid_args');
  });

  it('reads a symbol or a line range with line numbers, at most 200 lines', async () => {
    const r = await runAskTool(ctx, 'read_source', { id: await refundId() });
    expect(r.content).toContain('17| def refund(order_id: int) -> dict:');
    expect(r.content).toContain('payments.refund_payment(order_id, order["total"])');
    const long = await runAskTool(ctx, 'read_source', { path: 'app/long_values.py', start: 50, end: 400 });
    expect(long.content).toContain('50| VALUE_50 = 50');
    expect(long.content).toContain('249| VALUE_249 = 249');
    expect(long.content).not.toContain('250| VALUE_250');
    expect(long.content).toContain('continue with start=250');
  });

  it('does not read files that changed after indexing', async () => {
    writeFileSync(path.join(env.repo, 'README.md'), 'changed after indexing\n');
    expect((await runAskTool(ctx, 'read_source', { path: 'README.md' })).error).toBe('file_changed');
  });

  it('grep_code finds literal text case-insensitively, only in listed files', async () => {
    const r = await runAskTool(ctx, 'grep_code', { text: 'REFUND_PAYMENT(' });
    expect(r.content).toMatch(/app\/orders\/service\.py:19 \[in refund \w+\]: payments\.refund_payment\(order_id, order\["total"\]\)/);
    expect((await runAskTool(ctx, 'grep_code', { text: 'refund', pathPrefix: '../' })).content).toContain('No lines contain');
    const limited = await runAskTool(ctx, 'grep_code', { text: 'VALUE_', limit: 3 });
    expect(limited.content.split('\n').filter((l) => l.startsWith('app/'))).toHaveLength(3);
    expect(limited.content).toContain('more matches not shown');
  });

  it('grep_code skips files it cannot read (outside symlink, no permission) instead of failing', async () => {
    const files = env.store.getFiles(env.snapshot.id).map((f) => f.path);
    expect(files).toEqual(expect.arrayContaining(['app/outside_link.py', 'notes/locked.txt']));
    const r = await runAskTool(ctx, 'grep_code', { text: 'refund_payment(' });
    expect(r.error).toBeUndefined();
    expect(r.content).toContain('app/orders/service.py:19');
    expect(r.content).not.toContain('outside_link');
    expect(r.content).not.toContain('locked');
  });

  it('grep_code takes file rows from one query and stops when aborted', async () => {
    const getFile = vi.spyOn(env.store, 'getFile');
    try {
      await runAskTool(ctx, 'grep_code', { text: 'refund' });
      expect(getFile).not.toHaveBeenCalled();
    } finally {
      getFile.mockRestore();
    }
    await expect(runAskTool({ ...ctx, signal: AbortSignal.abort() }, 'grep_code', { text: 'refund' })).rejects.toThrow();
  });

  it('with source sending off returns only signatures and locations', async () => {
    const off = toolContext(env, { sendSource: false });
    const byId = await runAskTool(off, 'read_source', { id: await refundId() });
    expect(byId.content).toContain('source sending is turned off');
    expect(byId.content).toContain('sig: ');
    expect(byId.content).not.toContain('refund_payment(order_id');
    const byPath = await runAskTool(off, 'read_source', { path: 'app/orders/service.py', start: 1, end: 30 });
    expect(byPath.content).toContain('create_order');
    expect(byPath.content).not.toContain('repository.save_order');
    expect((await runAskTool(off, 'read_source', { path: '../x' })).error).toBe('path_not_allowed');
    const grep = await runAskTool(off, 'grep_code', { text: 'refund_payment(' });
    expect(grep.content).toContain('app/orders/service.py:19 [in refund');
    expect(grep.content).not.toContain('order["total"]');
  });
});

describe('result truncation', () => {
  it('cuts results at 8000 characters and gives the full length', () => {
    const text = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 500);
    const cut = truncateToolResult(text);
    expect(cut.startsWith('x'.repeat(MAX_TOOL_RESULT_CHARS))).toBe(true);
    expect(cut).toContain(`已截断，共 ${text.length} 字符`);
    expect(truncateToolResult('short')).toBe('short');
  });
});
