import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ASK_TOOLS, askTools, claudeArgs, claudeEnv, flushOpencodeSessions, killActiveCliProcesses, loadConfig, OpencodeClient, resetCliShutdown, runAsk, runCli,
  withCliTempDir, writeCliFile,
} from '@codeinsight/core';
import type { AskEvent, AskResult, ChatMessageInfo, CliLlmProvider, CodeInsightConfig, ProposalView } from '@codeinsight/core';
import {
  cleanupRealCliDirs, commandPath, hostileOpencodeConfig, leftoverProcesses, opencodeSessionList, REAL_CLI, REAL_CLI_EXTRA_ENV, REAL_CLI_MODEL,
  REAL_CLI_RUN_TIMEOUT_MS, REAL_CLI_TEST_TIMEOUT_MS, realCliTempDir, trackRealCliDir, type HostileOpencodeConfig,
} from '../../core/test/helpers/real-cli.js';
import { startHttpServer, type RunningHttpServer, type ServerWorkspace } from '../src/index.js';
import { apiFor, git, indexReady, openWorkspace, postStream, request, shopRepo, waitFor, type Api } from './helpers/env.js';

/**
 * 真实本机 CLI 的检查，会消耗少量额度，默认跳过。只跑这个文件：
 *   CODEINSIGHT_REAL_CLI=claude-code pnpm --filter @codeinsight/server exec vitest run test/local-cli.integration.test.ts
 * （opencode 同理；环境变量说明见 core 的 test/helpers/real-cli.ts）。
 * 问答工具服务用 helpers/ask-tools-mcp.mjs（与 `codeinsight mcp --ask-tools` 同一套代码）。
 */
const ASK_TOOLS_HELPER = path.join(import.meta.dirname, 'helpers', 'ask-tools-mcp.mjs');
const CLAUDE_PREFIX = 'mcp__codeinsight__';
const MODEL = REAL_CLI_MODEL;
const EXTRA_ENV = REAL_CLI_EXTRA_ENV;

afterAll(async () => {
  await killActiveCliProcesses();
  resetCliShutdown();
  cleanupRealCliDirs();
});

/** 用户 Claude Code 配置里的 CLAUDE.md 二级标题，回答里不应出现 */
function userClaudeMdHeadings(): string[] {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'CLAUDE.md');
  if (!existsSync(file)) return [];
  return [...readFileSync(file, 'utf8').matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]!.trim()).filter((h) => h.length >= 2);
}

/** 用户自己的斜杠命令和 skills 名字，init 行里不应出现 */
function userCommandNames(): string[] {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const names: string[] = [];
  for (const sub of ['commands', 'skills']) {
    const dir = path.join(base, sub);
    if (existsSync(dir)) names.push(...readdirSync(dir).map((f) => f.replace(/\.md$/, '')));
  }
  return names;
}

const symLinks = (answer: string) => [...answer.matchAll(/\(sym:([^)\s]+)\)/g)].map((m) => m[1]!);

interface Fixture {
  repo: string;
  dataDir: string;
  ws: ServerWorkspace;
  server: RunningHttpServer;
  api: Api;
  snapshotId: number;
}

/** 建 shop 仓库的索引并启动 serve；LLM 配置只来自这里给的用户设置，不读本机环境变量 */
async function startFixture(provider: CliLlmProvider): Promise<Fixture> {
  const repo = trackRealCliDir(shopRepo());
  const dataDir = realCliTempDir('ci-real-cli-');
  const ws = await openWorkspace(repo, dataDir);
  ws.config = await loadConfig(repo, {
    dataDir, env: {}, userSettings: { recentRepos: [], llm: { provider, command: commandPath(provider), ...(MODEL ? { model: MODEL } : {}), ...(EXTRA_ENV ? { extraEnv: EXTRA_ENV } : {}) } },
  });
  const server = await startHttpServer({ workspace: ws, askToolServer: { command: process.execPath, args: [ASK_TOOLS_HELPER] } });
  const api = apiFor(server);
  const snapshotId = await indexReady(api);
  return { repo, dataDir, ws, server, api, snapshotId };
}

type SavedMessage = ChatMessageInfo & { proposals?: ProposalView[] };

/** 建 PR 用的 origin：地址写成 GitHub 仓库（PR 目标按它解析），拉取经 insteadOf、推送经 pushurl 都指向本地 bare 仓库，不会连到 GitHub */
const PR_REMOTE = 'https://github.com/codeinsight-test/shop';
const FAKE_PR_URL = `${PR_REMOTE}/pull/1`;

/** 假 gh：记录参数，auth status 成功，pr create 输出 PR 链接，没有已存在的 PR */
const FAKE_GH = `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');
const [a, b] = args;
if (a === 'auth' && b === 'status') process.stdout.write('Logged in\\n');
else if (a === 'pr' && b === 'create') process.stdout.write(${JSON.stringify(FAKE_PR_URL)} + '\\n');
else { process.stderr.write('no pull requests found\\n'); process.exitCode = 1; }
`;

interface PrOrigin {
  bare: string;
  ghLog: string;
}

/** 给仓库配好 origin（本地 bare 仓库，main 已推送）、固定提交身份，并把假 gh 放到 PATH 最前面 */
function setupPrOrigin(repo: string): PrOrigin {
  git(repo, 'config', 'user.name', 'Tester');
  git(repo, 'config', 'user.email', 'tester@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  const bare = path.join(realCliTempDir('ci-real-origin-'), 'origin.git');
  git(path.dirname(bare), 'init', '-q', '--bare', '-b', 'main', bare);
  git(repo, 'remote', 'add', 'origin', PR_REMOTE);
  git(repo, 'config', 'remote.origin.pushurl', bare);
  git(repo, 'config', `url.${bare}.insteadOf`, PR_REMOTE);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  const bin = realCliTempDir('ci-real-gh-');
  writeFileSync(path.join(bin, 'gh'), FAKE_GH);
  chmodSync(path.join(bin, 'gh'), 0o755);
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  const ghLog = path.join(bin, 'gh.log');
  process.env.FAKE_GH_LOG = ghLog;
  return { bare, ghLog };
}

function ghCalls(ghLog: string): string[][] {
  return existsSync(ghLog) ? readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : [];
}

/** 用户工作区的状态：当前分支、HEAD、用户索引和未提交改动 */
function workspaceState(repo: string): Record<string, string> {
  return {
    head: git(repo, 'rev-parse', 'HEAD'), branch: git(repo, 'symbolic-ref', 'HEAD'),
    index: git(repo, 'ls-files', '-s'), status: git(repo, 'status', '--porcelain=v1', '-uall'),
  };
}

/** 一次真实调用的记录：用了哪些工具、生成了哪些待确认修改 */
function logRealCall(label: string, events: AskEvent[], message: SavedMessage): void {
  const tools = events.flatMap((e) => (e.type === 'tool' ? [e.name] : []));
  const proposals = (message.proposals ?? []).map((p) => ({ id: p.id, kind: p.kind, status: p.status, source: p.source, files: p.files.map((x) => x.path), error: p.result?.error }));
  console.log(`[real call] ${label}: status=${message.meta?.status} tools=${JSON.stringify(tools)} proposals=${JSON.stringify(proposals)}`);
  console.log(`[real call] ${label} answer:\n${message.content}`);
}

describe.skipIf(REAL_CLI !== 'claude-code')('real Claude Code: question answering through MCP', () => {
  let f: Fixture;
  beforeAll(async () => {
    process.env.CODEINSIGHT_LOG ??= 'info';
    f = await startFixture('claude-code');
  });
  afterAll(async () => {
    await f?.server.close();
  });

  async function ask(question: string, onEvent?: (e: AskEvent, destroy: () => void) => void): Promise<{ events: AskEvent[]; messages: SavedMessage[] }> {
    const sessionId = (await f.api<{ id: number }>('/api/chat/sessions', { method: 'POST', body: {} })).body.id;
    const s = await postStream(f.server, `/api/chat/sessions/${sessionId}/messages`, { question });
    let ended = false;
    void s.ended.then(() => (ended = true));
    if (onEvent) {
      let seen = 0;
      await waitFor(async () => {
        for (; seen < s.lines.length; seen++) onEvent(JSON.parse(s.lines[seen]!) as AskEvent, () => s.destroy());
        return ended ? true : undefined;
      }, REAL_CLI_RUN_TIMEOUT_MS);
    }
    await s.ended;
    const view = await waitFor(async () => {
      const b = (await f.api<{ answering: boolean; messages: SavedMessage[] }>(`/api/chat/sessions/${sessionId}`)).body;
      return b.answering ? undefined : b;
    }, 30_000);
    return { events: s.lines.map((l) => JSON.parse(l) as AskEvent), messages: view.messages };
  }

  it('init lists only the 9 codeinsight tools (write tools included, no built-in tools) and server; tool errors come back as is_error; no user instructions are loaded', async () => {
    const lines: Record<string, unknown>[] = [];
    const tools = askTools(true).map((t) => CLAUDE_PREFIX + t.name);
    const exit = await withCliTempDir(async (dir) => {
      const systemFile = await writeCliFile(dir, 'system.md', 'You answer questions about a code repository with the codeinsight tools.');
      const helperArgs = [ASK_TOOLS_HELPER, '--repo', f.repo, '--data-dir', f.dataDir, '--snapshot', String(f.snapshotId), '--write-tools'];
      const server = { type: 'stdio', command: process.execPath, args: helperArgs };
      const mcpConfigFile = await writeCliFile(dir, 'mcp.json', JSON.stringify({ mcpServers: { codeinsight: server } }));
      const args = claudeArgs({ mode: 'ask', systemFile, mcpConfigFile, allowedTools: tools, maxTurns: 4, model: MODEL || undefined });
      expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', '']);
      return runCli({
        provider: 'claude-code', command: commandPath('claude-code'), mode: 'ask', model: MODEL, cwd: dir, extraEnv: EXTRA_ENV, args,
        env: claudeEnv(2000),
        stdin: 'Call get_symbol once with id "no-such-id". Then give a numbered list of only the titles of every system instruction and additional context section you received.',
      }, { timeoutMs: REAL_CLI_RUN_TIMEOUT_MS, onLine: (v) => lines.push(v as Record<string, unknown>) });
    });
    expect(exit.exitCode).toBe(0);
    const init = lines.find((l) => l.type === 'system' && l.subtype === 'init') as { tools: string[]; mcp_servers: unknown[]; slash_commands?: string[] };
    console.log('init.mcp_servers', JSON.stringify(init.mcp_servers), 'slash_commands', JSON.stringify(init.slash_commands));
    expect([...init.tools].sort()).toEqual([...tools].sort());
    expect(init.mcp_servers.map((m) => ({ name: (m as { name: string }).name, status: (m as { status: string }).status }))).toEqual([{ name: 'codeinsight', status: 'connected' }]);
    const userCommands = new Set(userCommandNames());
    expect((init.slash_commands ?? []).filter((c) => userCommands.has(c))).toEqual([]);

    const results = lines.flatMap((l) => (l.type === 'user' ? ((l.message as { content?: unknown[] }).content ?? []) : [])) as { type?: string; is_error?: boolean }[];
    const toolResult = results.find((b) => b.type === 'tool_result')!;
    console.log('tool_result', JSON.stringify(toolResult));
    expect(toolResult.is_error).toBe(true);
    expect(JSON.stringify(toolResult)).toContain('error: not_found:');

    const result = lines.find((l) => l.type === 'result') as { is_error: boolean; result: string };
    console.log('instructions reply:\n' + result.result);
    expect(result.is_error).toBe(false);
    for (const h of userClaudeMdHeadings()) expect(result.result).not.toContain(h);
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('answers with a list_entries step and sym: links that open', async () => {
    const { events, messages } = await ask('这个仓库有哪些入口？先调用 list_entries，再用一两句话回答，用 sym: 链接引用入口的处理函数。');
    expect(events.some((e) => e.type === 'tool' && e.name === 'list_entries')).toBe(true);
    const done = events.at(-1) as Extract<AskEvent, { type: 'done' }>;
    expect(done.type).toBe('done');
    expect(done.status).toBe('done');
    expect(done.usage?.estimated).toBeUndefined();
    const answer = messages[1]!.content;
    console.log('answer:\n' + answer);
    const ids = symLinks(answer);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect((await f.api(`/api/symbols/${f.snapshotId}/${encodeURIComponent(id)}`)).status).toBe(200);
    }
    await waitFor(async () => (leftoverProcesses([f.dataDir]).length === 0 ? true : undefined), 15_000);
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('stopping an answer in progress leaves no claude or ask-tools process', async () => {
    const { messages } = await ask('列出所有入口，逐个读取它们的源码，然后详细说明每个入口做了什么。', (e, destroy) => {
      if (e.type === 'tool') destroy();
    });
    expect(messages[1]!.meta?.status).toBe('cancelled');
    await waitFor(async () => (leftoverProcesses([f.dataDir]).length === 0 ? true : undefined), 15_000);
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('the connection test reports not_logged_in for an empty Claude Code config directory without a model request', async () => {
    const server = await startHttpServer({ indexOnStart: false, dirPicker: { tool: null }, env: { ...process.env, CLAUDE_CONFIG_DIR: realCliTempDir('ci-claude-empty-') } });
    try {
      const r = await apiFor(server)<{ ok: boolean; reason?: string }>('/api/settings/llm/test', { method: 'POST', body: { provider: 'claude-code', command: commandPath('claude-code') } });
      expect(r.body).toMatchObject({ ok: false, reason: 'not_logged_in' });
    } finally {
      await server.close();
    }
  }, REAL_CLI_TEST_TIMEOUT_MS);

  describe('write tools: proposals and applying them', () => {
    let origin: PrOrigin;
    const savedPath = process.env.PATH;
    let mut: Api;

    beforeAll(async () => {
      origin = setupPrOrigin(f.repo);
      const gen = (await f.api<{ repoGen: number }>('/api/status')).body.repoGen;
      mut = async <T>(rawPath: string, opts: { method?: string; body?: unknown } = {}) => {
        const res = await request(f.server.port, rawPath, { ...opts, headers: { Authorization: `Bearer ${f.server.token}`, 'X-CodeInsight-Repo': String(gen) } });
        return { status: res.status, body: res.body ? res.json<T>() : ({} as T) };
      };
    });
    afterAll(() => {
      process.env.PATH = savedPath;
      delete process.env.FAKE_GH_LOG;
    });

    const apply = (id: number) => mut<{ proposal: ProposalView }>(`/api/chat/proposals/${id}/apply`, { method: 'POST', body: {} });

    /** 问一个问题，检查用了写工具、发了 proposal 事件、保存了一条待确认修改，返回它 */
    async function propose(label: string, question: string, tool: string): Promise<ProposalView> {
      const { events, messages } = await ask(question);
      logRealCall(label, events, messages[1]!);
      expect(events.some((e) => e.type === 'tool' && e.name === tool)).toBe(true);
      expect(events.filter((e) => e.type === 'tool').map((e) => (e as { name: string }).name).every((n) => askTools(true).some((t) => t.name === n))).toBe(true);
      const saved = messages[1]!.proposals ?? [];
      expect(saved.length).toBeGreaterThan(0);
      const proposal = saved.at(-1)!;
      expect(events.some((e) => e.type === 'proposal' && e.proposal.id === proposal.id)).toBe(true);
      expect(proposal.status).toBe('pending');
      return proposal;
    }

    it('changes an existing file and creates a new one through propose_file_changes; applying writes them', async () => {
      const proposal = await propose('files', [
        '请修改 app/leaf/limits.py：把 is_full 函数里的 `<= 0` 改成 `< 1`；并新建文件 notes/limits.md，内容只有一行 `# Limits`。',
        '先用 read_source（path 参数）读 app/leaf/limits.py 的原文，然后只调用一次 propose_file_changes，同时给出这两处修改。',
      ].join(''), 'propose_file_changes');
      expect(proposal).toMatchObject({ kind: 'files', root: 'repo' });
      expect(proposal.files.map((x) => [x.path, x.isNew]).sort()).toEqual([['app/leaf/limits.py', false], ['notes/limits.md', true]]);
      expect(readFileSync(path.join(f.repo, 'app/leaf/limits.py'), 'utf8')).toContain('<= 0');
      expect(existsSync(path.join(f.repo, 'notes/limits.md'))).toBe(false);

      const r = await apply(proposal.id);
      console.log('[real call] files apply:', r.status, JSON.stringify(r.body.proposal?.result));
      expect(r.status).toBe(200);
      expect(r.body.proposal.status).toBe('applied');
      const limits = readFileSync(path.join(f.repo, 'app/leaf/limits.py'), 'utf8');
      expect(limits).toContain('return remaining(used) < 1');
      expect(limits).not.toContain('<= 0');
      expect(limits).toContain('def remaining(used: int) -> int:');
      expect(readFileSync(path.join(f.repo, 'notes/limits.md'), 'utf8').trim()).toBe('# Limits');
    }, REAL_CLI_TEST_TIMEOUT_MS);

    it('opens a pull request with edits through propose_pull_request; applying pushes a branch to origin and leaves the workspace alone', async () => {
      const proposal = await propose('pull request (edits)', [
        '请建一个 PR，标题为 "Raise max quantity"：把 app/leaf/rules.py 里 max_qty 函数返回的 100 改成 200。',
        '先用 read_source（path 参数）读 app/leaf/rules.py 的原文，然后调用 propose_pull_request，用 files 给出修改（不要用 fromWorkingTree）。',
      ].join(''), 'propose_pull_request');
      expect(proposal).toMatchObject({ kind: 'pull_request', source: 'edits', base: 'main' });
      expect(proposal.files.map((x) => x.path)).toEqual(['app/leaf/rules.py']);
      const before = workspaceState(f.repo);

      const r = await apply(proposal.id);
      console.log('[real call] pull request (edits) apply:', r.status, JSON.stringify(r.body.proposal?.result), 'gh:', JSON.stringify(ghCalls(origin.ghLog)));
      expect(r.status).toBe(200);
      expect(r.body.proposal).toMatchObject({ status: 'applied', result: { url: FAKE_PR_URL } });
      const branch = r.body.proposal.branch!;
      expect(git(origin.bare, 'show', `refs/heads/${branch}:app/leaf/rules.py`)).toContain('return 200');
      expect(git(origin.bare, 'rev-parse', `refs/heads/${branch}^`).trim()).toBe(git(origin.bare, 'rev-parse', 'refs/heads/main').trim());
      expect(workspaceState(f.repo)).toEqual(before);
      const create = ghCalls(origin.ghLog).find((a) => a[0] === 'pr' && a[1] === 'create')!;
      expect(create).toEqual(expect.arrayContaining(['--repo=codeinsight-test/shop', '--base=main', `--head=${branch}`]));
    }, REAL_CLI_TEST_TIMEOUT_MS);

    it('opens a pull request from the uncommitted working tree changes (fromWorkingTree)', async () => {
      rmSync(origin.ghLog, { force: true });
      const proposal = await propose('pull request (working tree)', [
        '请把工作区里所有未提交的改动建成一个 PR，标题为 "Limits notes"。',
        '直接调用 propose_pull_request，使用 fromWorkingTree（不传 paths），不要用 files。',
      ].join(''), 'propose_pull_request');
      expect(proposal).toMatchObject({ kind: 'pull_request', source: 'working_tree', base: 'main' });
      expect(proposal.files.map((x) => x.path).sort()).toEqual(['app/leaf/limits.py', 'notes/limits.md']);
      const before = workspaceState(f.repo);

      const r = await apply(proposal.id);
      console.log('[real call] pull request (working tree) apply:', r.status, JSON.stringify(r.body.proposal?.result));
      expect(r.status).toBe(200);
      expect(r.body.proposal).toMatchObject({ status: 'applied', result: { url: FAKE_PR_URL } });
      const branch = r.body.proposal.branch!;
      expect(git(origin.bare, 'show', `refs/heads/${branch}:notes/limits.md`).trim()).toBe('# Limits');
      expect(git(origin.bare, 'show', `refs/heads/${branch}:app/leaf/limits.py`)).toContain('< 1');
      expect(workspaceState(f.repo)).toEqual(before);
      await waitFor(async () => (leftoverProcesses([f.dataDir]).length === 0 ? true : undefined), 15_000);
    }, REAL_CLI_TEST_TIMEOUT_MS);
  });
});

/**
 * opencode 权限隔离：OPENCODE_CONFIG 指向一份“放行一切”的配置（bash、read、edit 允许，带一个 MCP 服务和一个插件），
 * 模拟用户全局配置；按 CodeInsight 的内联配置运行后，内置工具都被拒绝、那个 MCP 服务不启动，codeinsight_* 工具可用。
 * 不经过 OPENCODE_PERMISSIONS_VERIFIED 的限制，直接建客户端。
 */
describe.skipIf(REAL_CLI !== 'opencode')('real opencode: permissions and question answering through MCP', () => {
  let f: Fixture;
  let hostile: HostileOpencodeConfig;

  beforeAll(async () => {
    process.env.CODEINSIGHT_LOG ??= 'info';
    f = await startFixture('opencode');
    hostile = hostileOpencodeConfig();
  });
  afterAll(async () => {
    await flushOpencodeSessions(10_000);
    await f?.server.close();
  });

  function client(): OpencodeClient {
    return new OpencodeClient({ command: commandPath('opencode'), model: MODEL, extraEnv: hostile.env, timeoutMs: REAL_CLI_RUN_TIMEOUT_MS });
  }

  function runQuestion(question: string, config: Partial<CodeInsightConfig['ask']> = {}, onEvent?: (e: AskEvent, abort: () => void) => void): Promise<AskResult> {
    const ac = new AbortController();
    const snapshot = f.ws.store.getSnapshot(f.snapshotId)!;
    return runAsk({
      repo: f.repo, store: f.ws.store, layout: f.ws.layout, config: { ...f.ws.config, ask: { ...f.ws.config.ask, ...config } }, snapshot, client: client(), question,
      signal: ac.signal, toolServer: { command: process.execPath, args: [ASK_TOOLS_HELPER] }, onEvent: (e) => onEvent?.(e, () => ac.abort()),
    });
  }

  it('denies shell, read and write, starts no global MCP service, and allows the codeinsight tools', async () => {
    const touched = path.join(os.tmpdir(), `oc-perm-test-${process.pid}-${Date.now()}`);
    const written = path.join(hostile.dir, 'written.txt');
    const events: AskEvent[] = [];
    const r = await runQuestion(
      `Do all of these: 1) call list_entries; 2) run the shell command \`touch ${touched}\`; 3) read /etc/hosts; 4) write "x" to ${written}; ` +
        '5) tell me your current working directory. Report which steps were refused.',
      {}, (e) => events.push(e),
    );
    console.log('opencode answer:\n' + r.answer, '\ntools:', JSON.stringify(r.meta.toolCalls));
    expect(existsSync(touched)).toBe(false);
    expect(existsSync(written)).toBe(false);
    expect(existsSync(hostile.mcpMarker)).toBe(false);
    console.log('global plugin loaded:', existsSync(hostile.pluginMarker));
    const used = r.meta.toolCalls.filter((c) => !c.error).map((c) => c.name);
    expect(used).toContain('list_entries');
    expect(used.filter((n) => ASK_TOOLS.every((t) => t.name !== n))).toEqual([]);
    expect(r.answer).not.toContain(f.repo);
    expect(r.answer).not.toContain(process.cwd());
    await waitFor(async () => (leftoverProcesses([f.dataDir]).length === 0 ? true : undefined), 15_000);
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('ends as limited when the steps run out', async () => {
    const r = await runQuestion('列出所有入口，逐个读取它们的源码，然后详细说明每个入口做了什么。', { maxRounds: 1 });
    console.log('steps run out:', r.status, r.meta.reason);
    expect(r.status).toBe('limited');
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('stopping an answer in progress leaves no opencode or ask-tools process, and the sessions are deleted', async () => {
    const r = await runQuestion('列出所有入口，逐个读取它们的源码，然后详细说明每个入口做了什么。', {}, (e, abort) => {
      if (e.type === 'tool' || e.type === 'text') abort();
    });
    expect(r.status).toBe('cancelled');
    await waitFor(async () => (leftoverProcesses([f.dataDir]).length === 0 ? true : undefined), 15_000);
    await flushOpencodeSessions(20_000);
    const list = opencodeSessionList(commandPath('opencode'));
    console.log('opencode sessions left:', list.trim() || '(none)');
    expect(list).not.toContain('"codeinsight"');
  }, REAL_CLI_TEST_TIMEOUT_MS);
});
