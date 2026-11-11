import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { completeWithLog, createLlmClient, DEFAULT_ANTHROPIC_MODEL, LlmError, loadConfig, setLogSink } from '../src/index.js';
import { tempDir } from './helpers/git-repo.js';

interface Captured {
  url: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

/** 本地假 LLM 服务：记录请求，按路径返回固定响应 */
let server: Server;
let baseUrl: string;
const captured: Captured[] = [];
let failNext = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      captured.push({ url: req.url!, headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> });
      res.setHeader('content-type', 'application/json');
      if (failNext) {
        failNext = false;
        res.statusCode = 529;
        res.end('{"error":{"type":"overloaded_error"}}');
      } else if (req.url!.endsWith('/v1/messages')) res.end(JSON.stringify({ content: [{ type: 'text', text: '{"groups":[]}' }] }));
      else res.end(JSON.stringify({ choices: [{ message: { content: '{"groups":[]}' } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const REQ = { system: 'sys', messages: [{ role: 'user' as const, content: 'hello' }], maxTokens: 100 };

describe('LLM clients against a local fake server', () => {
  it('anthropic: posts to /v1/messages with the key header and returns the text', async () => {
    const client = createLlmClient({ provider: 'anthropic', model: 'm-a', apiKey: 'test-key', baseUrl });
    expect(await client.complete(REQ)).toBe('{"groups":[]}');
    const c = captured.at(-1)!;
    expect(c.url).toBe('/v1/messages');
    expect(c.headers['x-api-key']).toBe('test-key');
    expect(c.headers['anthropic-version']).toBe('2023-06-01');
    expect(c.body).toEqual({ model: 'm-a', max_tokens: 100, system: 'sys', messages: [{ role: 'user', content: 'hello' }] });
  });

  it('openai-compatible: posts to /chat/completions, key optional', async () => {
    const client = createLlmClient({ provider: 'openai-compatible', model: 'llama', baseUrl: `${baseUrl}/v1/` });
    expect(await client.complete(REQ)).toBe('{"groups":[]}');
    const c = captured.at(-1)!;
    expect(c.url).toBe('/v1/chat/completions');
    expect(c.headers.authorization).toBeUndefined();
    expect(c.body).toMatchObject({ model: 'llama', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }] });
  });

  it('raises LlmError with the status on HTTP errors and keeps the key out of the logs', async () => {
    const lines: string[] = [];
    const restore = setLogSink((l) => lines.push(l));
    const level = process.env.CODEINSIGHT_LOG;
    process.env.CODEINSIGHT_LOG = 'debug';
    try {
      const client = createLlmClient({ provider: 'openai-compatible', model: 'llama', apiKey: 'sk-secret-123', baseUrl });
      failNext = true;
      const err = await completeWithLog(client, REQ, { items: 3, attempt: 1 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).status).toBe(529);
      expect(captured.at(-1)!.headers.authorization).toBe('Bearer sk-secret-123');
    } finally {
      setLogSink(restore);
      if (level === undefined) delete process.env.CODEINSIGHT_LOG;
      else process.env.CODEINSIGHT_LOG = level;
    }
    expect(lines.some((l) => l.includes('llm_request') && l.includes('items=3') && l.includes('model=llama'))).toBe(true);
    expect(lines.some((l) => l.includes('llm_failed') && l.includes('status=529'))).toBe(true);
    expect(lines.join('\n')).not.toContain('sk-secret-123');
    expect(lines.join('\n')).not.toContain('hello');
  });

  it('requires an API key for anthropic', () => {
    expect(() => createLlmClient({ provider: 'anthropic', model: 'm' })).toThrow('API key');
  });
});

describe('LLM config', () => {
  it('defaults the anthropic model and requires a model for openai-compatible', async () => {
    const repo = tempDir();
    expect((await loadConfig(repo, { env: { CODEINSIGHT_LLM_PROVIDER: 'anthropic' } })).llm).toMatchObject({ provider: 'anthropic', model: DEFAULT_ANTHROPIC_MODEL });
    expect(DEFAULT_ANTHROPIC_MODEL).toBe('claude-sonnet-5-5');
    const own = await loadConfig(repo, { env: { CODEINSIGHT_LLM_PROVIDER: 'anthropic', CODEINSIGHT_LLM_MODEL: 'claude-other' } });
    expect(own.llm?.model).toBe('claude-other');
    await expect(loadConfig(repo, { env: { CODEINSIGHT_LLM_PROVIDER: 'openai-compatible' } })).rejects.toThrow('model is missing');
  });
});
