import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  askJson, createLlmClient, LlmError, llmCacheKey, llmIdentity, notifyLlmOnce, parseRetryAfter, readLlmCache, runIntentCheck,
  setLogSink, writeFileAtomic, writeLlmCache,
} from '../src/index.js';
import type { AskJsonRequest, JsonParseResult, LlmClient } from '../src/index.js';
import { startFakeLlm, type FakeLlm } from './helpers/fake-llm-server.mjs';
import { tempDir } from './helpers/git-repo.js';

let fake: FakeLlm;
beforeAll(async () => {
  fake = await startFakeLlm();
});
afterAll(() => fake.close());
beforeEach(() => {
  fake.requests.length = 0;
});

function parseName(reply: string): JsonParseResult<string> {
  try {
    const v = JSON.parse(reply) as { name?: unknown };
    return typeof v.name === 'string' ? { ok: true, value: v.name } : { ok: false, reason: 'missing "name"' };
  } catch {
    return { ok: false, reason: 'reply is not valid JSON' };
  }
}

function request(client: LlmClient, extra: Partial<AskJsonRequest<string>> = {}): AskJsonRequest<string> {
  return { client, system: 'sys', prompt: 'name it', maxTokens: 100, items: 1, parse: parseName, retryPrompt: (r) => `invalid: ${r}`, ...extra };
}

const anthropic = () => createLlmClient({ provider: 'anthropic', model: 'm-a', apiKey: 'k', baseUrl: fake.url });
const openai = () => createLlmClient({ provider: 'openai-compatible', model: 'llama', baseUrl: fake.url });

async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const restore = setLogSink((l) => lines.push(l));
  const level = process.env.CODEINSIGHT_LOG;
  process.env.CODEINSIGHT_LOG = 'debug';
  try {
    return { result: await fn(), lines };
  } finally {
    setLogSink(restore);
    if (level === undefined) delete process.env.CODEINSIGHT_LOG;
    else process.env.CODEINSIGHT_LOG = level;
  }
}

describe('askJson against the fake LLM server', () => {
  it('waits for retry-after on 429 and retries when transientRetries allows it', async () => {
    fake.setScript([{ status: 429, headers: { 'retry-after': '1' }, errorType: 'rate_limit_error' }, '{"name":"orders"}']);
    const { result, lines } = await captureLogs(() => askJson(request(anthropic(), { transientRetries: 2 })));
    expect(result).toEqual({ ok: true, value: 'orders' });
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]!.at - fake.requests[0]!.at).toBeGreaterThanOrEqual(950);
    expect(lines.some((l) => l.includes('WARN llm_retry') && l.includes('status=429') && l.includes('waitMs=1000'))).toBe(true);
    expect(lines.some((l) => l.includes('llm_failed') && l.includes('retryAfterMs=1000'))).toBe(true);
  });

  it('retries 5xx as well, and gives up when the retries are used up', async () => {
    fake.setScript([{ status: 503, headers: { 'retry-after': '0' } }, { status: 529, headers: { 'retry-after': '0' } }, { status: 529, headers: { 'retry-after': '0' } }]);
    const r = await askJson(request(openai(), { transientRetries: 2 }));
    expect(fake.requests).toHaveLength(3);
    expect(r).toMatchObject({ ok: false, failure: 'request' });
    expect((r as { error: LlmError }).error.status).toBe(529);
  });

  it('does not retry a 429 by default', async () => {
    fake.setScript([{ status: 429, headers: { 'retry-after': '0' } }, '{"name":"x"}']);
    const r = await askJson(request(anthropic()));
    expect(fake.requests).toHaveLength(1);
    expect(r).toMatchObject({ ok: false, failure: 'request', error: { status: 429, retryAfterMs: 0 } });
  });

  it('retries an invalid JSON reply once, telling the model why', async () => {
    fake.setScript(['Sure, here it is', '{"name":"payments"}']);
    const r = await askJson(request(openai()));
    expect(r).toEqual({ ok: true, value: 'payments' });
    expect(fake.requests).toHaveLength(2);
    const messages = fake.requests[1]!.body.messages as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(messages[3]!.content).toBe('invalid: reply is not valid JSON');
  });

  it('gives up after two invalid replies', async () => {
    fake.setScript(['{"title":"x"}']);
    const r = await askJson(request(anthropic(), { transientRetries: 2 }));
    expect(fake.requests).toHaveLength(2);
    expect(r).toEqual({ ok: false, failure: 'invalid', reason: 'missing "name"' });
  });

  it('does not retry a truncated reply', async () => {
    fake.setScript([{ text: '{"name":', truncated: true }, '{"name":"x"}']);
    const r = await askJson(request(anthropic(), { transientRetries: 2 }));
    expect(fake.requests).toHaveLength(1);
    expect(r).toMatchObject({ ok: false, failure: 'truncated', error: { maxTokens: 100 } });
  });
});

describe('intent check keeps not retrying', () => {
  it('stops at the first 429 even when the server asks to retry', async () => {
    fake.setScript([{ status: 429, headers: { 'retry-after': '0' } }]);
    const items = [{ key: 'a.py#function#f#', module: 'a', change: 'added' as const, displaySignature: '()', docLine: null }];
    const refs = new Map([['a.py#function#f#', { key: 'a.py#function#f#', id: 'x', kind: 'function', name: 'f', qualifiedName: 'f', path: 'a.py', startLine: 1, isTest: false }]]);
    const r = await runIntentCheck({ intentText: 'add f', items, addedFiles: [], refs, client: anthropic(), cacheDir: tempDir('ci-llm-cache-') });
    expect(fake.requests).toHaveLength(1);
    expect(r.warnings).toMatchObject([{ code: 'llm_failed', message: expect.stringContaining('HTTP 429') }]);
  });
});

describe('retry-after parsing', () => {
  it('accepts seconds and HTTP dates, ignoring anything else', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('0.5')).toBe(500);
    const now = Date.parse('2026-11-12T00:00:00Z');
    expect(parseRetryAfter('Thu, 12 Nov 2026 00:00:03 GMT', now)).toBe(3000);
    expect(parseRetryAfter('Wed, 11 Nov 2026 00:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe('LLM file cache', () => {
  it('keys the identity by provider, request address and model', () => {
    const base = llmIdentity({ provider: 'anthropic', model: 'm', baseUrl: 'http://a' });
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(llmIdentity({ provider: 'anthropic', model: 'm', baseUrl: 'http://a' })).toBe(base);
    expect(llmIdentity({ provider: 'anthropic', model: 'm', baseUrl: 'http://b' })).not.toBe(base);
    expect(llmIdentity({ provider: 'openai-compatible', model: 'm', baseUrl: 'http://a' })).not.toBe(base);
    expect(llmIdentity({ provider: 'anthropic', model: 'n', baseUrl: 'http://a' })).not.toBe(base);
    expect(llmCacheKey(['a', 'b'])).not.toBe(llmCacheKey(['ab']));
  });

  it('round-trips an entry and treats corrupt or rejected entries as misses', async () => {
    const dir = tempDir('ci-llm-cache-');
    const pick = (e: unknown) => (e as { name?: string }).name;
    expect(await readLlmCache(dir, 'k1', pick)).toBeUndefined();
    await writeLlmCache(dir, 'k1', { name: 'orders' });
    expect(await readLlmCache(dir, 'k1', pick)).toBe('orders');
    expect(await readLlmCache(dir, 'k1', () => undefined)).toBeUndefined();
    writeFileSync(path.join(dir, 'k2.json'), '{"name":');
    expect(await readLlmCache(dir, 'k2', pick)).toBeUndefined();
    expect(readdirSync(dir).sort()).toEqual(['k1.json', 'k2.json']);
  });

  it('writes files atomically into a new directory and leaves no temporary file on failure', async () => {
    const dir = tempDir('ci-atomic-');
    const file = path.join(dir, 'nested', 'a.json');
    await writeFileAtomic(file, 'one');
    await writeFileAtomic(file, 'two');
    expect(readFileSync(file, 'utf8')).toBe('two');
    expect(readdirSync(path.dirname(file))).toEqual(['a.json']);
    const blocker = path.join(dir, 'blocker');
    writeFileSync(blocker, '');
    await expect(writeFileAtomic(path.join(blocker, 'x.json'), 'x')).rejects.toThrow();
    expect(readdirSync(dir).sort()).toEqual(['blocker', 'nested']);
  });
});

describe('LLM notice', () => {
  it('notifies once per provider, model and message', () => {
    const seen: string[] = [];
    const client = { provider: 'fake-notice', model: 'm' };
    notifyLlmOnce(client, 'sending summary', (m) => seen.push(m));
    notifyLlmOnce(client, 'sending summary', (m) => seen.push(m));
    notifyLlmOnce(client, 'sending source', (m) => seen.push(m));
    notifyLlmOnce({ ...client, model: 'n' }, 'sending summary', (m) => seen.push(m));
    expect(seen).toEqual(['sending summary', 'sending source', 'sending summary']);
  });
});
