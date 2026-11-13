import { chmodSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ASK_TOOLS, askClient, ClaudeCodeClient, flushOpencodeSessions, killActiveCliProcesses, LIMIT_EMPTY_ANSWER, OpencodeClient, opencodeSessions, resetCliShutdown, runAsk, runAskTool,
} from '../src/index.js';
import type { AskEvent, AskOptions, CliClientOptions, LlmClient } from '../src/index.js';
import { cliAskPrompt, toolErrorOf } from '../src/ask/cli-agent.js';
import { askEnv, idOf, toolContext, type AskEnv } from './helpers/ask-env.js';
import { tempDir } from './helpers/git-repo.js';

const FAKE_CLAUDE = path.join(import.meta.dirname, 'helpers', 'fake-claude.mjs');
const FAKE_OPENCODE = path.join(import.meta.dirname, 'helpers', 'fake-opencode.mjs');
const TOOL_SERVER = { command: process.execPath, args: ['/opt/codeinsight/main.js', 'mcp', '--ask-tools'] };

interface Rec {
  pid: number;
  argv: string[];
  stdin: string;
  system?: { mode: string; content: string };
  mcp?: { mode: string; content: { mcpServers: Record<string, { type: string; command: string; args: string[] }> } };
  env: Record<string, string>;
  sessionDelete?: string;
}

let recordFile = '';
function records(): Rec[] {
  if (!existsSync(recordFile)) return [];
  return readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Rec);
}

function scenario(name: string, env: Record<string, string> = {}): void {
  recordFile = path.join(tempDir('ci-ask-cli-rec-'), 'record.jsonl');
  process.env.FAKE_CLI_SCENARIO = name;
  process.env.FAKE_CLI_RECORD = recordFile;
  for (const k of ['FAKE_CLI_TOOL_RESULT', 'FAKE_CLI_TOOL_ERROR', 'FAKE_CLI_MCP_STATUS', 'FAKE_CLI_NO_USAGE', 'FAKE_CLI_RECORD_ENV']) delete process.env[k];
  Object.assign(process.env, env);
}

const claude = (o: Partial<CliClientOptions> = {}) => new ClaudeCodeClient({ command: FAKE_CLAUDE, model: '', timeoutMs: 20_000, ...o });
const opencode = () => new OpencodeClient({ command: FAKE_OPENCODE, model: '', timeoutMs: 20_000 });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

let env: AskEnv;
beforeAll(async () => {
  process.env.CODEINSIGHT_LOG = 'silent';
  chmodSync(FAKE_CLAUDE, 0o755);
  chmodSync(FAKE_OPENCODE, 0o755);
  process.env.CLAUDE_CONFIG_DIR = tempDir('ci-claude-cfg-');
  process.env.XDG_CONFIG_HOME = tempDir('ci-xdg-');
  env = await askEnv();
});
beforeEach(() => resetCliShutdown());
afterAll(async () => {
  await flushOpencodeSessions(5_000);
  await killActiveCliProcesses();
  env.store.close();
});

async function ask(client: LlmClient, extra: Partial<AskOptions> = {}): Promise<{ result: Awaited<ReturnType<typeof runAsk>>; events: AskEvent[] }> {
  const events: AskEvent[] = [];
  const result = await runAsk({
    repo: env.repo, store: env.store, layout: env.layout, config: env.config, snapshot: env.snapshot,
    client, question: '退款流程怎么走？', toolServer: TOOL_SERVER, onEvent: (e) => events.push(e), ...extra,
  });
  return { result, events };
}

const kinds = (events: AskEvent[]) => events.filter((e) => e.type !== 'text').map((e) => (e.type === 'tool' || e.type === 'tool_done' ? `${e.type}:${e.name}` : e.type));
const STREAM_KINDS = ['start', 'tool:search_symbols', 'tool:get_symbol', 'tool_done:search_symbols', 'tool_done:get_symbol', 'done'];

async function refundLine(): Promise<{ text: string; id: string }> {
  const out = await runAskTool(toolContext(env), 'search_symbols', { query: 'refund' });
  return { text: out.content, id: idOf(out.content, 'refund', 'app/orders/service.py')! };
}

describe('CLI question answering (Claude Code)', () => {
  it('turns stream-json into start → text → tool → tool_done → text → done, with refs and usage from the result', async () => {
    const refund = await refundLine();
    scenario('stream', { FAKE_CLI_TOOL_RESULT: refund.text });
    const { result, events } = await ask(claude());
    expect(kinds(events)).toEqual(STREAM_KINDS);
    expect(events.findIndex((e) => e.type === 'text')).toBe(1);
    expect(result.status).toBe('done');
    expect(result.answer).toBe('先查一下。\n\n退款由 refund 处理。');
    expect(events.filter((e) => e.type === 'tool_done')).toEqual([
      { type: 'tool_done', name: 'search_symbols', resultChars: refund.text.length },
      { type: 'tool_done', name: 'get_symbol', resultChars: 'error: not_found: no symbol with this id'.length, error: 'not_found' },
    ]);
    expect(events.find((e) => e.type === 'tool')).toEqual({ type: 'tool', name: 'search_symbols', args: { query: 'refund' } });
    expect(result.meta.refs[refund.id]?.qualifiedName).toBe('refund');
    expect(result.meta.usage).toEqual({ inputTokens: 16, outputTokens: 7, costUsd: 0.001 });
    expect(result.meta.toolCalls.map((c) => c.name)).toEqual(['search_symbols', 'get_symbol']);
  });

  it('runs claude with the ask arguments, a 600 mcp.json for the tool server and the question on stdin', async () => {
    scenario('stream');
    await ask(claude({ model: 'sonnet' }));
    const r = records()[0]!;
    const opt = (name: string) => r.argv[r.argv.indexOf(name) + 1];
    expect(r.argv.slice(0, 5)).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']);
    expect(opt('--allowedTools')).toBe(ASK_TOOLS.map((t) => `mcp__codeinsight__${t.name}`).join(','));
    expect(opt('--max-turns')).toBe(String(env.config.ask.maxRounds + 1));
    expect(opt('--tools')).toBe('');
    expect(r.argv).toContain('--model=sonnet');
    expect(r.stdin).toBe('退款流程怎么走？');
    expect(r.argv.join(' ')).not.toContain('退款');
    expect(r.system?.mode).toBe('600');
    expect(r.system?.content).toContain('mcp__codeinsight__');
    expect(r.mcp?.mode).toBe('600');
    const server = r.mcp!.content.mcpServers.codeinsight!;
    expect(server.command).toBe(process.execPath);
    expect(server.args).toEqual([
      ...TOOL_SERVER.args, '--repo', env.repo, '--data-dir', env.layout.root, '--snapshot', String(env.snapshot.id), '--max-tool-chars', String(env.config.ask.maxToolChars),
    ]);
  });

  it('passes --no-source to the tool server when source sending is off', async () => {
    scenario('stream');
    await ask(claude(), { noSource: true });
    expect(records()[0]!.mcp!.content.mcpServers.codeinsight!.args).toContain('--no-source');
  });

  it('puts the session history before the question on stdin and saves both messages', async () => {
    const sessionId = env.store.chats.createSession('t');
    scenario('stream');
    await ask(claude(), { sessionId });
    await ask(claude(), { sessionId, question: '那取消呢？' });
    expect(records()[1]!.stdin).toBe(cliAskPrompt([{ question: '退款流程怎么走？', answer: '先查一下。\n\n退款由 refund 处理。' }], '那取消呢？'));
    expect(records()[1]!.stdin).toContain('用户：退款流程怎么走？\n回答：');
    const saved = env.store.chats.messages(sessionId);
    expect(saved.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(saved[1]!.meta?.toolCalls).toHaveLength(2);
  });

  it('uses the assistant text blocks when there are no partial messages', async () => {
    scenario('stream-no-partial');
    const { result, events } = await ask(claude());
    expect(kinds(events)).toEqual(STREAM_KINDS);
    expect(result.answer).toBe('先查一下。\n\n退款由 refund 处理。');
  });

  it('estimates usage when the result has none', async () => {
    scenario('stream', { FAKE_CLI_NO_USAGE: '1' });
    const { result } = await ask(claude());
    expect(result.meta.usage?.estimated).toBe(true);
    expect(result.meta.usage?.inputTokens).toBeGreaterThan(0);
  });

  it('error_max_turns ends as limited max_rounds with the fixed note when there is no text', async () => {
    scenario('max-turns');
    const { result, events } = await ask(claude());
    expect(result.status).toBe('limited');
    expect(result.meta.reason).toBe('max_rounds');
    expect(result.answer).toBe(LIMIT_EMPTY_ANSWER);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'limited', reason: 'max_rounds' });
  });

  it('tool results over ask.maxToolChars end as limited max_tool_chars', async () => {
    scenario('stream', { FAKE_CLI_TOOL_RESULT: 'x'.repeat(200) });
    const { result } = await ask(claude(), { config: { ...env.config, ask: { ...env.config.ask, maxToolChars: 100 } } });
    expect(result.status).toBe('limited');
    expect(result.meta.reason).toBe('max_tool_chars');
  });

  it('not logged in fails with llm_failed and the login hint', async () => {
    scenario('not-logged-in');
    const { result, events } = await ask(claude());
    expect(result.status).toBe('failed');
    expect(result.meta.error?.code).toBe('llm_failed');
    expect(result.meta.error?.message).toMatch(/not logged in.*run `claude`/);
    expect(events.at(-1)?.type).toBe('error');
  });

  it('a user abort ends as cancelled, keeps the received text and ends the CLI process', async () => {
    scenario('stream-then-hang');
    const sessionId = env.store.chats.createSession('t');
    const ac = new AbortController();
    const p = ask(claude(), { sessionId, signal: ac.signal, onEvent: (e) => e.type === 'text' && ac.abort() });
    const { result } = await p;
    expect(result.status).toBe('cancelled');
    expect(result.answer.length).toBeGreaterThan(0);
    expect(env.store.chats.messages(sessionId)[1]!.meta?.status).toBe('cancelled');
    await waitFor(() => !alive(records()[0]!.pid));
  });

  it('the question timeout ends as failed timeout', async () => {
    scenario('stream-then-hang');
    const { result } = await ask(claude(), { timeoutMs: 1_000 });
    expect(result.status).toBe('failed');
    expect(result.meta.error?.code).toBe('timeout');
    await waitFor(() => !alive(records()[0]!.pid));
  });

  it('fails with internal_error when the caller gives no tool server', async () => {
    scenario('stream');
    const { result } = await ask(claude(), { toolServer: undefined });
    expect(result.meta.error?.code).toBe('internal_error');
    expect(records()).toHaveLength(0);
  });

  it.each(['failed', 'needs-auth', 'pending'])('ends as failed and stops claude when the tool service is %s in the init line', async (status) => {
    scenario('stream', { FAKE_CLI_MCP_STATUS: status });
    const { result, events } = await ask(claude());
    expect(result.status).toBe('failed');
    expect(result.meta.error?.code).toBe('internal_error');
    expect(result.meta.error?.message).toContain(`tool service did not start (status: ${status})`);
    expect(result.meta.error?.message).toContain(status === 'pending' ? 'did not finish starting in time' : 'after the index is rebuilt');
    expect(result.answer).toBe('');
    expect(events.some((e) => e.type === 'tool' || e.type === 'text')).toBe(false);
    await waitFor(() => !alive(records()[0]!.pid));
  });

  it('reads the error code from a tool_result whose content is a plain string, as Claude Code sends MCP tool errors', async () => {
    scenario('stream', { FAKE_CLI_TOOL_STRING: '1' });
    const { events } = await ask(claude());
    expect(events.find((e) => e.type === 'tool_done' && e.name === 'get_symbol')).toMatchObject({ error: 'not_found' });
  });

  it('a tool_result marked is_error without an error code is a tool error', async () => {
    scenario('stream', { FAKE_CLI_TOOL_ERROR: '<tool_use_error>MCP error -32603: boom</tool_use_error>' });
    const { events } = await ask(claude());
    expect(events.find((e) => e.type === 'tool_done' && e.name === 'get_symbol')).toMatchObject({ error: 'internal_error' });
  });

  it('reads the error code through the wrappers CLIs put around tool errors', () => {
    expect(toolErrorOf('error: not_found: x', false)).toBe('not_found');
    expect(toolErrorOf('<tool_use_error>error: path_not_allowed: x</tool_use_error>', true)).toBe('path_not_allowed');
    expect(toolErrorOf('<tool_use_error>Error: error: invalid_args: x</tool_use_error>', true)).toBe('invalid_args');
    expect(toolErrorOf('Error: error: file_changed: x', true)).toBe('file_changed');
    expect(toolErrorOf('  error: not_found: x\n', true)).toBe('not_found');
    expect(toolErrorOf('Error: something else', true)).toBe('internal_error');
    expect(toolErrorOf('error: skipped: limit', false)).toBeUndefined();
    expect(toolErrorOf('plain result', false)).toBeUndefined();
  });

  it('killActiveCliProcesses ends a running question as cancelled', async () => {
    scenario('stream-then-hang');
    let started!: () => void;
    const textSeen = new Promise<void>((r) => (started = r));
    const p = ask(claude(), { onEvent: (e) => e.type === 'text' && started() });
    await textSeen;
    await killActiveCliProcesses({ keepSessionDelete: true });
    const { result } = await p;
    expect(result.status).toBe('cancelled');
    expect(result.meta.error?.message).toContain('shutting down');
    expect(alive(records()[0]!.pid)).toBe(false);
  });

  it('askClient accepts a CLI client without chat', () => {
    const c = askClient({ llm: undefined, llmProblem: undefined }, { client: claude() });
    expect('client' in c).toBe(true);
  });
});

describe('CLI question answering (opencode)', () => {
  it('turns text and tool_use lines into events, sums step usage and deletes the session', async () => {
    scenario('stream', { FAKE_CLI_RECORD_ENV: 'OPENCODE_CONFIG_CONTENT' });
    const { result, events } = await ask(opencode());
    expect(kinds(events)).toEqual(['start', 'tool:search_symbols', 'tool_done:search_symbols', 'tool:get_symbol', 'tool_done:get_symbol', 'done']);
    expect(result.answer).toBe('先查一下。\n\n退款由 refund 处理。');
    expect(events.find((e) => e.type === 'tool_done' && e.name === 'get_symbol')).toMatchObject({ error: 'not_found' });
    expect(result.meta.usage).toEqual({ inputTokens: 48, outputTokens: 12, costUsd: 0.004 });
    const config = JSON.parse(records()[0]!.env.OPENCODE_CONFIG_CONTENT!) as { agent: { codeinsight: { steps: number; permission: Record<string, string> } }; mcp: { codeinsight: { command: string[] } } };
    expect(config.agent.codeinsight.steps).toBe(env.config.ask.maxRounds);
    expect(config.agent.codeinsight.permission).toEqual({ '*': 'deny', 'codeinsight_*': 'allow' });
    expect(config.mcp.codeinsight.command.slice(0, 4)).toEqual([TOOL_SERVER.command, ...TOOL_SERVER.args]);
    await flushOpencodeSessions(5_000);
    expect(records().some((r) => r.sessionDelete === 'ses_fake123')).toBe(true);
  });

  it('tool_use lines with status error are tool errors', async () => {
    scenario('steps-error-tool');
    const { events } = await ask(opencode());
    expect(events.find((e) => e.type === 'tool_done')).toMatchObject({ name: 'search_symbols', error: 'internal_error' });
  });

  it('while shutting down with keepSessionDelete, new questions do not start but session deletes still run', async () => {
    scenario('stream');
    await killActiveCliProcesses({ keepSessionDelete: true });
    const { result } = await ask(opencode());
    expect(result.status).toBe('failed');
    expect(records().filter((r) => r.argv[0] === 'run')).toHaveLength(0);
    opencodeSessions.enqueue({ sessionId: 'ses_keep', command: FAKE_OPENCODE, baseEnv: process.env, disabledMcp: [] });
    await flushOpencodeSessions(5_000);
    expect(records().some((r) => r.sessionDelete === 'ses_keep')).toBe(true);
  });

  it('a last step that did not finish normally ends as limited max_rounds', async () => {
    scenario('steps-exhausted');
    const { result } = await ask(opencode());
    expect(result.status).toBe('limited');
    expect(result.meta.reason).toBe('max_rounds');
    expect(result.answer).toBe(LIMIT_EMPTY_ANSWER);
  });
});
