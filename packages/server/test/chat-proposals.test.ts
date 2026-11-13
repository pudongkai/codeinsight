import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PathNotAllowedError, PROPOSAL_APPLYING_STALE_MS, PROPOSAL_INTERRUPTED, proposalView, resetCliShutdown, writeFileAtomic } from '@codeinsight/core';
import type { AskEvent, ChatMessageInfo, ProposalView } from '@codeinsight/core';
import { startHttpServer, type RunningHttpServer, type ServerWorkspace } from '../src/index.js';
import {
  fakeLlmEnv, firstUserText, startFakeLlm, toolResults, type FakeLlm, type FakeLlmReply, type FakeLlmRequest,
} from '../../core/test/helpers/fake-llm-server.mjs';
import { apiFor, git, indexReady, openWorkspace, postStream, request, shopRepo, tempDir, waitFor, writeFiles, type Api } from './helpers/env.js';

const FAKE_CLAUDE = path.resolve(import.meta.dirname, '..', '..', 'core', 'test', 'helpers', 'fake-claude.mjs');

type MessageView = ChatMessageInfo & { proposals?: ProposalView[] };

/** 一个问题的剧本：第一轮调用这些写工具，收到工具结果后先执行 beforeFinal，再给最后的回复 */
interface Plan {
  calls: { name: string; input: Record<string, unknown> }[];
  beforeFinal?: () => void;
  final?: FakeLlmReply;
}

const plans = new Map<string, Plan>();
let questionNo = 0;

function reply(req: FakeLlmRequest): FakeLlmReply {
  const plan = plans.get(firstUserText(req));
  if (!plan) return 'no plan';
  if (toolResults(req).length === 0) return { toolCalls: plan.calls };
  plan.beforeFinal?.();
  return plan.final ?? '请在页面上确认。';
}

let fake: FakeLlm;
let repo: string;
let home: string;
let notesDir: string;
let ws: ServerWorkspace;
let server: RunningHttpServer;
let api: Api;
/** 带 X-CodeInsight-Repo 的请求（apply、dismiss 必须带） */
let mut: Api;
const extraServers: RunningHttpServer[] = [];

beforeAll(async () => {
  process.env.CODEINSIGHT_LOG = 'silent';
  fake = await startFakeLlm({ reply });
  repo = realpathSync(shopRepo());
  writeFiles(repo, { 'scripts/run.sh': '#!/bin/sh\necho old\n', 'docs/guide.md': 'line one\nline two\n' });
  chmodSync(path.join(repo, 'scripts/run.sh'), 0o755);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'files');
  home = realpathSync(tempDir('ci-proposals-home-'));
  notesDir = path.join(home, 'notes');
  mkdirSync(notesDir);
  ws = await openWorkspace(repo, tempDir('ci-proposals-data-'), undefined, fakeLlmEnv(fake.url));
  server = await startHttpServer({ workspace: ws, addDirs: [notesDir], addDirCheck: { home, systemDirs: [] } });
  api = apiFor(server);
  await indexReady(api);
  mut = await repoApi(server);
});

/** 按 /api/status 的 repoGen 带上 X-CodeInsight-Repo */
async function repoApi(s: RunningHttpServer): Promise<Api> {
  const gen = (await apiFor(s)<{ repoGen: number }>('/api/status')).body.repoGen;
  return async <T>(rawPath: string, opts: { method?: string; body?: unknown } = {}) => {
    const res = await request(s.port, rawPath, { ...opts, headers: { Authorization: `Bearer ${s.token}`, 'X-CodeInsight-Repo': String(gen) } });
    return { status: res.status, body: res.body ? res.json<T>() : ({} as T) };
  };
}

afterAll(async () => {
  for (const s of extraServers) await s.close();
  await server?.close();
  await fake?.close();
});

async function newSession(a: Api = api): Promise<number> {
  return (await a<{ id: number }>('/api/chat/sessions', { method: 'POST', body: {} })).body.id;
}

/** 按剧本问一个问题，等回答结束，返回事件和会话里的回答 */
async function askWith(plan: Plan, target: RunningHttpServer = server): Promise<{ events: AskEvent[]; answer: MessageView }> {
  const question = `q${++questionNo}`;
  plans.set(question, plan);
  const a = apiFor(target);
  const sessionId = await newSession(a);
  const s = await postStream(target, `/api/chat/sessions/${sessionId}/messages`, { question });
  await s.ended;
  const events = s.lines.map((l) => JSON.parse(l) as AskEvent);
  const view = (await a<{ messages: MessageView[] }>(`/api/chat/sessions/${sessionId}`)).body;
  return { events, answer: view.messages[1]! };
}

const fileCall = (input: Record<string, unknown>) => ({ name: 'propose_file_changes', input: { summary: 'change', ...input } });

/** 生成一条待确认的修改，返回它的 id */
async function propose(input: Record<string, unknown>, target: RunningHttpServer = server): Promise<number> {
  const { answer } = await askWith({ calls: [fileCall(input)] }, target);
  expect(answer.proposals).toHaveLength(1);
  expect(answer.proposals![0]!.status).toBe('pending');
  return answer.proposals![0]!.id;
}

type ApplyBody = { proposal: ProposalView; error?: string; files?: { path: string; code: string; canForce: boolean }[] };
const apply = (id: number, body: Record<string, unknown> = {}, a: Api = mut) =>
  a<ApplyBody>(`/api/chat/proposals/${id}/apply`, { method: 'POST', body });

const proposalEvents = (events: AskEvent[]) => events.filter((e): e is Extract<AskEvent, { type: 'proposal' }> => e.type === 'proposal');

describe('saving proposals with the answer (API)', () => {
  it('saves a successful write call as a pending proposal, emits a proposal event without contents and shows it in the session', async () => {
    const { events, answer } = await askWith({
      calls: [
        fileCall({ files: [{ path: 'docs/new.md', create: 'SECRET-NEW' }, { path: 'docs/guide.md', edits: [{ old: 'line two', new: 'line 2' }] }] }),
        fileCall({ files: [{ path: '.git/hooks/x', create: 'bad' }] }),
      ],
    });
    const ev = proposalEvents(events);
    expect(ev).toHaveLength(1);
    expect(events.findIndex((e) => e.type === 'proposal')).toBeLessThan(events.findIndex((e) => e.type === 'done'));
    expect(ev[0]!.proposal).toMatchObject({
      kind: 'files', status: 'pending', summary: 'change', root: 'repo', messageId: answer.id,
      files: [{ path: 'docs/new.md', isNew: true }, { path: 'docs/guide.md', isNew: false }],
    });
    expect(JSON.stringify(events)).not.toContain('SECRET-NEW');
    expect(JSON.stringify(ev[0]!.proposal)).not.toContain(repo);
    expect(answer.proposals).toEqual([ev[0]!.proposal]);
    expect(existsSync(path.join(repo, 'docs/new.md'))).toBe(false);
  });

  it('also saves proposals when the answer is limited', async () => {
    const { events, answer } = await askWith({ calls: [fileCall({ files: [{ path: 'docs/limited.md', create: 'x' }] })], final: { text: 'partial', truncated: true } });
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'limited' });
    expect(answer.proposals!.map((p) => p.status)).toEqual(['pending']);
  });

  it('records a proposal that can no longer be built at save time as failed and refuses to apply it', async () => {
    const target = path.join(repo, 'docs/drift.md');
    writeFileSync(target, 'alpha\n');
    const { answer } = await askWith({
      calls: [fileCall({ files: [{ path: 'docs/drift.md', edits: [{ old: 'alpha', new: 'beta' }] }] })],
      beforeFinal: () => writeFileSync(target, 'changed meanwhile\n'),
    });
    const p = answer.proposals![0]!;
    expect(p.status).toBe('failed');
    expect(p.result?.error?.code).toBe('invalid_args');
    expect(p.files).toEqual([{ path: 'docs/drift.md', isNew: false }]);
    const r = await apply(p.id);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('not_applicable');
    expect(readFileSync(target, 'utf8')).toBe('changed meanwhile\n');
  });

  it('does not save proposals when the question is cancelled', async () => {
    const question = `q${++questionNo}`;
    plans.set(question, { calls: [fileCall({ files: [{ path: 'docs/cancel.md', create: 'x' }] })], final: { text: 'partial', hang: true } });
    const sessionId = await newSession();
    const s = await postStream(server, `/api/chat/sessions/${sessionId}/messages`, { question });
    await waitFor(async () => (s.lines.some((l) => l.includes('"text"')) ? true : undefined), 30_000);
    s.destroy();
    const view = await waitFor(async () => {
      const b = (await api<{ answering: boolean; messages: MessageView[] }>(`/api/chat/sessions/${sessionId}`)).body;
      return b.answering ? undefined : b;
    }, 30_000);
    expect(view.messages[1]!.meta?.status).toBe('cancelled');
    expect(view.messages[1]!.proposals).toEqual([]);
  });
});

describe('applying file proposals', () => {
  it('writes the files, keeps the executable bit and records the written files', async () => {
    const id = await propose({ files: [{ path: 'scripts/run.sh', edits: [{ old: 'echo old', new: 'echo new' }] }, { path: 'docs/sub/added.md', create: 'added\n' }] });
    const r = await apply(id);
    expect(r.status).toBe(200);
    expect(r.body.proposal).toMatchObject({ id, status: 'applied', result: { written: ['scripts/run.sh', 'docs/sub/added.md'] } });
    expect(readFileSync(path.join(repo, 'scripts/run.sh'), 'utf8')).toBe('#!/bin/sh\necho new\n');
    expect(statSync(path.join(repo, 'scripts/run.sh')).mode & 0o777).toBe(0o755);
    expect(readFileSync(path.join(repo, 'docs/sub/added.md'), 'utf8')).toBe('added\n');
    expect((await apply(id)).body.error).toBe('invalid_status');
  });

  it('fails when the path is no longer allowed at apply time', async () => {
    const id = await propose({ files: [{ path: 'linked/new.md', create: 'x' }] });
    const outside = tempDir('ci-proposals-outside-');
    symlinkSync(outside, path.join(repo, 'linked'));
    try {
      const r = await apply(id);
      expect(r.status).toBe(200);
      expect(r.body.proposal.status).toBe('failed');
      expect(r.body.proposal.result).toMatchObject({ written: [], error: { code: 'write_not_allowed' } });
      expect(existsSync(path.join(outside, 'new.md'))).toBe(false);
    } finally {
      rmSync(path.join(repo, 'linked'));
    }
  });

  it('returns 409 file_changed_since_proposal when the file changed, and writes with force', async () => {
    const file = path.join(repo, 'docs/guide.md');
    const id = await propose({ files: [{ path: 'docs/guide.md', edits: [{ old: 'line one', new: 'LINE ONE' }] }] });
    writeFileSync(file, 'line one\nline two\nedited by user\n');
    const r = await apply(id);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('file_changed_since_proposal');
    expect(r.body.files).toEqual([{ path: 'docs/guide.md', code: 'file_changed_since_proposal', canForce: true }]);
    expect(r.body.proposal.status).toBe('pending');
    expect(readFileSync(file, 'utf8')).toBe('line one\nline two\nedited by user\n');
    const forced = await apply(id, { force: true });
    expect(forced.body.proposal.status).toBe('applied');
    expect(readFileSync(file, 'utf8')).toBe('LINE ONE\nline two\n');
  });

  it('returns 409 file_exists when a new file was created before applying; force overwrites only inside the repository', async () => {
    const inRepo = await propose({ files: [{ path: 'docs/race.md', create: 'from proposal' }] });
    writeFileSync(path.join(repo, 'docs/race.md'), 'someone else');
    const r = await apply(inRepo);
    expect(r.status).toBe(409);
    expect(r.body.files).toEqual([{ path: 'docs/race.md', code: 'file_exists', canForce: true }]);
    expect((await apply(inRepo, { force: true })).body.proposal.status).toBe('applied');
    expect(readFileSync(path.join(repo, 'docs/race.md'), 'utf8')).toBe('from proposal');

    const outside = await propose({ root: 'dir1', files: [{ path: 'todo.md', create: 'from proposal' }] });
    writeFileSync(path.join(notesDir, 'todo.md'), 'mine');
    for (const body of [{}, { force: true }]) {
      const o = await apply(outside, body);
      expect(o.status).toBe(409);
      expect(o.body.files).toEqual([{ path: 'todo.md', code: 'file_exists', canForce: false }]);
    }
    expect(readFileSync(path.join(notesDir, 'todo.md'), 'utf8')).toBe('mine');
    rmSync(path.join(notesDir, 'todo.md'));
    expect((await apply(outside)).body.proposal).toMatchObject({ status: 'applied', root: 'dir1', rootDir: 'notes' });
    expect(readFileSync(path.join(notesDir, 'todo.md'), 'utf8')).toBe('from proposal');
  });

  it('returns 409 while the same proposal is applying', async () => {
    const id = await propose({ files: [{ path: 'docs/busy.md', create: 'x' }] });
    expect(ws.store.proposals.startApplying(id)).toBe(true);
    const r = await apply(id);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('proposal_applying');
    ws.store.proposals.revertApplying(id, 'pending');
    expect((await apply(id)).body.proposal.status).toBe('applied');
  });

  it('dismisses pending proposals only', async () => {
    const id = await propose({ files: [{ path: 'docs/dismiss.md', create: 'x' }] });
    expect((await api(`/api/chat/proposals/${id}/dismiss`, { method: 'POST' })).status).toBe(400);
    const r = await mut<{ proposal: ProposalView }>(`/api/chat/proposals/${id}/dismiss`, { method: 'POST' });
    expect(r.body.proposal.status).toBe('dismissed');
    expect((await mut(`/api/chat/proposals/${id}/dismiss`, { method: 'POST' })).status).toBe(409);
    expect((await apply(id)).body.error).toBe('invalid_status');
    expect((await mut('/api/chat/proposals/99999/dismiss', { method: 'POST' })).status).toBe(404);
    expect(existsSync(path.join(repo, 'docs/dismiss.md'))).toBe(false);
  });
});

describe('several write calls on the same file', () => {
  it('merges a call into the later one that touches its files: one card with the whole change, unrelated calls stay separate', async () => {
    writeFileSync(path.join(repo, 'docs/stack.md'), 'one\ntwo\n');
    const { events, answer } = await askWith({
      calls: [
        fileCall({ summary: 'first', files: [{ path: 'docs/stack.md', edits: [{ old: 'one', new: 'one\nADDED' }] }, { path: 'docs/stack-new.md', create: 'n\n' }] }),
        fileCall({ summary: 'other', files: [{ path: 'docs/stack-other.md', create: 'o\n' }] }),
        fileCall({ summary: 'second', files: [{ path: 'docs/stack.md', edits: [{ old: 'ADDED', new: 'ADDED again' }] }] }),
      ],
    });
    expect(events.filter((e) => e.type === 'tool_done').map((e) => e.type === 'tool_done' && e.error)).toEqual([undefined, undefined, undefined]);
    expect(answer.proposals!.map((p) => [p.summary, p.files.map((f) => [f.path, f.isNew])])).toEqual([
      ['other', [['docs/stack-other.md', true]]],
      ['first；second', [['docs/stack.md', false], ['docs/stack-new.md', true]]],
    ]);
    expect((await apply(answer.proposals![1]!.id)).body.proposal.status).toBe('applied');
    expect(readFileSync(path.join(repo, 'docs/stack.md'), 'utf8')).toBe('one\nADDED again\ntwo\n');
    expect(readFileSync(path.join(repo, 'docs/stack-new.md'), 'utf8')).toBe('n\n');
  });

  it('a later answer in the same session merges a pending card touching the same file; the old card becomes dismissed', async () => {
    const sessionId = await newSession();
    // 假模型按会话里第一个问题找剧本，第二次提问前换掉第一个问题的剧本
    const first = `q${++questionNo}`;
    const ask = async (calls: Plan['calls']) => {
      const question = plans.has(first) ? `q${++questionNo}` : first;
      plans.set(first, { calls });
      await (await postStream(server, `/api/chat/sessions/${sessionId}/messages`, { question })).ended;
      return (await api<{ messages: MessageView[] }>(`/api/chat/sessions/${sessionId}`)).body.messages;
    };
    await ask([fileCall({ summary: 'add', files: [{ path: 'docs/cross.md', create: 'base\n' }] })]);
    const messages = await ask([fileCall({ summary: 'more', files: [{ path: 'docs/cross.md', edits: [{ old: 'base', new: 'base+' }] }] })]);
    const [old, merged] = [messages[1]!.proposals![0]!, messages[3]!.proposals![0]!];
    expect(old).toMatchObject({ status: 'dismissed', result: { mergedInto: merged.id } });
    expect(merged).toMatchObject({ status: 'pending', summary: 'add；more', files: [{ path: 'docs/cross.md', isNew: true }] });
    expect((await apply(old.id)).body.error).toBe('invalid_status');
    expect((await apply(merged.id)).body.proposal.status).toBe('applied');
    expect(readFileSync(path.join(repo, 'docs/cross.md'), 'utf8')).toBe('base+\n');
  });

  it('allows applying again an applying proposal that has not been updated for too long', async () => {
    const id = await propose({ files: [{ path: 'docs/stale-applying.md', create: 'x' }] });
    expect(ws.store.proposals.startApplying(id)).toBe(true);
    expect(ws.store.proposals.startApplying(id)).toBe(false);
    ws.store.db.prepare('UPDATE chat_proposals SET updated_at = ? WHERE id = ?').run(Date.now() - PROPOSAL_APPLYING_STALE_MS - 1000, id);
    expect(proposalView(ws.store.proposals.get(id)!)).toMatchObject({ status: 'applying', retryable: true });
    const r = await apply(id);
    expect(r.status).toBe(200);
    expect(r.body.proposal.status).toBe('applied');
    expect(r.body.proposal.retryable).toBeUndefined();
    expect(readFileSync(path.join(repo, 'docs/stale-applying.md'), 'utf8')).toBe('x');
  });

  it('dismisses an applying proposal only after it has not been updated for too long', async () => {
    const id = await propose({ files: [{ path: 'docs/stale-dismiss.md', create: 'x' }] });
    expect(ws.store.proposals.startApplying(id)).toBe(true);
    expect(proposalView(ws.store.proposals.get(id)!).retryable).toBeUndefined();
    expect((await mut(`/api/chat/proposals/${id}/dismiss`, { method: 'POST' })).status).toBe(409);
    ws.store.db.prepare('UPDATE chat_proposals SET updated_at = ? WHERE id = ?').run(Date.now() - PROPOSAL_APPLYING_STALE_MS - 1000, id);
    const r = await mut<{ proposal: ProposalView }>(`/api/chat/proposals/${id}/dismiss`, { method: 'POST' });
    expect(r.body.proposal.status).toBe('dismissed');
  });
});

describe('applying: retries, root changes and the repository header', () => {
  it('requires the X-CodeInsight-Repo header', async () => {
    const id = await propose({ files: [{ path: 'docs/header.md', create: 'x' }] });
    const r = await apply(id, {}, api);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('repo_header_required');
    expect(ws.store.proposals.get(id)?.status).toBe('pending');
  });

  it('records a partial write, and a retry skips files already written and completes', async () => {
    mkdirSync(path.join(repo, 'locked'));
    const id = await propose({ files: [{ path: 'docs/part1.md', create: 'one\n' }, { path: 'locked/part2.md', create: 'two\n' }] });
    chmodSync(path.join(repo, 'locked'), 0o555);
    try {
      const r = await apply(id);
      expect(r.body.proposal).toMatchObject({ status: 'failed', result: { written: ['docs/part1.md'], error: { code: 'write_failed' } } });
    } finally {
      chmodSync(path.join(repo, 'locked'), 0o755);
    }
    expect(readdirSync(path.join(repo, 'locked'))).toEqual([]);
    const retry = await apply(id);
    expect(retry.status).toBe(200);
    expect(retry.body.proposal).toMatchObject({ status: 'applied', result: { written: ['docs/part1.md', 'locked/part2.md'] } });
    expect(readFileSync(path.join(repo, 'locked/part2.md'), 'utf8')).toBe('two\n');
  });

  it('fails with root_changed after the repository was switched, and fails when an --add-dir directory was removed', async () => {
    const id = await propose({ files: [{ path: 'docs/switched.md', create: 'x' }] });
    const other = realpathSync(shopRepo());
    const otherServer = await startHttpServer({ workspace: await openWorkspace(other, ws.layout.root), indexOnStart: false });
    extraServers.push(otherServer);
    const r = await apply(id, {}, await repoApi(otherServer));
    expect(r.body.proposal).toMatchObject({ status: 'failed', result: { written: [], error: { code: 'root_changed' } } });
    expect(existsSync(path.join(other, 'docs/switched.md'))).toBe(false);
    expect(existsSync(path.join(repo, 'docs/switched.md'))).toBe(false);

    const gone = path.join(home, 'gone');
    mkdirSync(gone);
    const withDir = await startHttpServer({ workspace: await openWorkspace(repo, ws.layout.root, undefined, fakeLlmEnv(fake.url)), addDirs: [gone], addDirCheck: { home, systemDirs: [] } });
    extraServers.push(withDir);
    await indexReady(apiFor(withDir));
    const dirId = await propose({ root: 'dir1', files: [{ path: 'x.md', create: 'x' }] }, withDir);
    rmSync(gone, { recursive: true });
    const d = await apply(dirId, {}, await repoApi(withDir));
    expect(d.body.proposal).toMatchObject({ status: 'failed', result: { error: { code: 'write_not_allowed' } } });
    expect(existsSync(gone)).toBe(false);
  });
});

describe('atomic write inside a root', () => {
  it('refuses a parent directory that became a link to outside the root, leaving nothing outside', async () => {
    const root = realpathSync(tempDir('ci-atomic-root-'));
    const outside = realpathSync(tempDir('ci-atomic-outside-'));
    symlinkSync(outside, path.join(root, 'a'));
    const err = await writeFileAtomic(path.join(root, 'a', 'b', 'c.txt'), 'x', { root, exclusive: true }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(PathNotAllowedError);
    expect(readdirSync(outside)).toEqual([]);
    await writeFileAtomic(path.join(root, 'd', 'e', 'f.txt'), 'ok', { root, exclusive: true });
    expect(readFileSync(path.join(root, 'd', 'e', 'f.txt'), 'utf8')).toBe('ok');
    expect(readdirSync(path.join(root, 'd', 'e'))).toEqual(['f.txt']);
  });
});

describe('proposal diff', () => {
  it('diffs against the current disk content and marks files changed since the proposal', async () => {
    writeFileSync(path.join(repo, 'docs/diff.md'), 'a\nb\n');
    const id = await propose({ files: [{ path: 'docs/diff.md', edits: [{ old: 'b', new: 'B' }] }, { path: 'docs/diff-new.md', create: 'hello\n' }] });
    type DiffBody = { files: { path: string; isNew: boolean; diff: string; changedSinceProposal?: true }[] };
    const r = await api<DiffBody>(`/api/chat/proposals/${id}/diff`);
    expect(r.status).toBe(200);
    expect(r.body.files.map((f) => [f.path, f.changedSinceProposal ?? false])).toEqual([['docs/diff.md', false], ['docs/diff-new.md', false]]);
    expect(r.body.files[0]!.diff).toMatch(/^--- a\/docs\/diff\.md\n\+\+\+ b\/docs\/diff\.md\n@@/);
    expect(r.body.files[0]!.diff).toContain('-b\n+B');
    expect(r.body.files[1]!.diff).toMatch(/^--- \/dev\/null\n\+\+\+ b\/docs\/diff-new\.md\n@@[^\n]*\n\+hello/);
    expect(r.body.files[0]!.diff).not.toContain(repo);
    writeFileSync(path.join(repo, 'docs/diff.md'), 'a\nb\nc\n');
    const after = await api<DiffBody>(`/api/chat/proposals/${id}/diff`);
    expect(after.body.files[0]!.changedSinceProposal).toBe(true);
    expect((await api('/api/chat/proposals/99999/diff')).status).toBe(404);
    writeFileSync(path.join(repo, 'docs/diff.md'), 'x'.repeat(1024 * 1024 + 1));
    const big = await api<DiffBody & { files: { tooLarge?: true }[] }>(`/api/chat/proposals/${id}/diff`);
    expect(big.body.files[0]).toMatchObject({ path: 'docs/diff.md', diff: '', tooLarge: true, changedSinceProposal: true });
  });
});

describe('pull request proposals (saving only)', () => {
  it('fetches origin/<base> before rebuilding edits and saves working tree sources with a tree', async () => {
    const origin = tempDir('ci-proposals-origin-');
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'fetch', '-q', 'origin');
    // 推一个新提交到 origin，本地的 origin/main 落后，保存时 fetch 后按新提交生成修改
    const other = tempDir('ci-proposals-clone-');
    git(other, 'clone', '-q', origin, '.');
    writeFiles(other, { 'docs/remote.md': 'remote one\n' });
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'remote');
    const pushed = git(other, 'rev-parse', 'HEAD').trim();
    const edits = { name: 'propose_pull_request', input: { title: 'Fix guide', base: 'main', branch: 'codeinsight/fix-guide', files: [{ path: 'docs/guide.md', edits: [{ old: 'line two', new: 'line 2' }] }] } };
    const tree = { name: 'propose_pull_request', input: { title: 'From tree', base: 'main', fromWorkingTree: {} } };
    const { answer } = await askWith({ calls: [edits, tree], beforeFinal: () => git(other, 'push', '-q', 'origin', 'main') });
    const [pr, wt] = answer.proposals!;
    expect(pr).toMatchObject({ kind: 'pull_request', status: 'pending', title: 'Fix guide', base: 'main', branch: 'codeinsight/fix-guide', source: 'edits', files: [{ path: 'docs/guide.md', isNew: false }] });
    expect(ws.store.proposals.get(pr!.id)?.payload).toMatchObject({ startCommit: pushed });
    expect(wt).toMatchObject({ kind: 'pull_request', status: 'pending', source: 'working_tree' });
    expect(wt!.files.length).toBeGreaterThan(0);
    const diff = await api<{ files: { diff: string }[] }>(`/api/chat/proposals/${pr!.id}/diff`);
    expect(diff.body.files[0]!.diff).toContain('-line two\n+line 2');

    const missing = path.join(tempDir('ci-proposals-gone-'), 'origin.git');
    const again = { ...edits, input: { ...edits.input, branch: 'codeinsight/fix-guide-2' } };
    const failed = await askWith({ calls: [again, { ...again, input: { ...again.input, branch: 'codeinsight/fix-guide-3' } }], beforeFinal: () => git(repo, 'remote', 'set-url', 'origin', missing) });
    git(repo, 'remote', 'set-url', 'origin', origin);
    const errors = failed.answer.proposals!.map((p) => p.result?.error);
    expect(errors.map((e) => e?.code)).toEqual(['fetch_failed', 'fetch_failed']);
    expect(errors[0]!.message).toMatch(/^git fetch origin main failed: /);
    expect(errors[0]!.message).not.toContain(missing);
    expect(errors[0]!.message).not.toMatch(/failed: git /);
  });
});

describe('pull request proposals on the same branch', () => {
  it('merges the calls into one pull request built on origin/<base> (origin set up by the previous test)', async () => {
    const pr = (input: Record<string, unknown>) => ({ name: 'propose_pull_request', input: { body: 'b', base: 'main', branch: 'codeinsight/stacked', ...input } });
    const { events, answer } = await askWith({
      calls: [
        pr({ title: 'One', files: [{ path: 'docs/guide.md', edits: [{ old: 'line two', new: 'line 2' }] }] }),
        pr({ title: 'Two', files: [{ path: 'docs/guide.md', edits: [{ old: 'line 2', new: 'line 2!' }] }, { path: 'docs/pr-new.md', create: 'x\n' }] }),
        pr({ title: 'Tree', fromWorkingTree: {} }),
      ],
    });
    expect(events.filter((e) => e.type === 'tool_done').map((e) => e.type === 'tool_done' && e.error)).toEqual([undefined, undefined, 'invalid_args']);
    expect(answer.proposals).toHaveLength(1);
    expect(answer.proposals![0]).toMatchObject({ title: 'Two', body: 'b', branch: 'codeinsight/stacked', files: [{ path: 'docs/guide.md' }, { path: 'docs/pr-new.md', isNew: true }] });
    const row = ws.store.proposals.get(answer.proposals![0]!.id)!;
    expect(row.kind === 'pull_request' && row.payload.files![0]!.content).toBe('line one\nline 2!\n');
  });
});

describe('recovering interrupted proposals at startup', () => {
  it('marks applying proposals failed only when their process has exited', async () => {
    const dead = await propose({ files: [{ path: 'docs/dead.md', create: 'x' }] });
    const live = await propose({ files: [{ path: 'docs/live.md', create: 'x' }] });
    const exited = spawn(process.execPath, ['-e', '']);
    await new Promise((r) => exited.on('exit', r));
    const running = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      const setApplying = ws.store.db.prepare("UPDATE chat_proposals SET status = 'applying', pid = ? WHERE id = ?");
      setApplying.run(exited.pid!, dead);
      setApplying.run(running.pid!, live);
      const w2 = await openWorkspace(repo, ws.layout.root, undefined, fakeLlmEnv(fake.url));
      extraServers.push(await startHttpServer({ workspace: w2, indexOnStart: false }));
      expect(ws.store.proposals.get(dead)).toMatchObject({ status: 'failed', result: { error: { code: 'interrupted', message: PROPOSAL_INTERRUPTED } } });
      expect(ws.store.proposals.get(live)?.status).toBe('applying');
      ws.store.db.prepare('UPDATE chat_proposals SET updated_at = ? WHERE id = ?').run(Date.now() - PROPOSAL_APPLYING_STALE_MS - 1000, live);
      const w3 = await openWorkspace(repo, ws.layout.root, undefined, fakeLlmEnv(fake.url));
      extraServers.push(await startHttpServer({ workspace: w3, indexOnStart: false }));
      expect(ws.store.proposals.get(live)).toMatchObject({ status: 'failed', result: { error: { code: 'interrupted' } } });
    } finally {
      running.kill('SIGKILL');
    }
  });
});

describe('saving proposals with the answer (Claude Code)', () => {
  it('rebuilds the successful write call, saves it and emits a proposal event; applying writes the file', async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    resetCliShutdown();
    process.env.CLAUDE_CONFIG_DIR = tempDir('ci-claude-cfg-');
    process.env.FAKE_CLI_SCENARIO = 'stream-write';
    process.env.FAKE_CLI_RECORD = path.join(tempDir('ci-proposals-rec-'), 'record.jsonl');
    try {
      const w = await openWorkspace(repo, ws.layout.root, undefined, { CODEINSIGHT_LLM_PROVIDER: 'claude-code', CODEINSIGHT_LLM_COMMAND: FAKE_CLAUDE });
      const cli = await startHttpServer({ workspace: w, askToolServer: { command: process.execPath, args: ['/unused'] } });
      extraServers.push(cli);
      const cliApi = apiFor(cli);
      await indexReady(cliApi);
      const sessionId = await newSession(cliApi);
      const s = await postStream(cli, `/api/chat/sessions/${sessionId}/messages`, { question: '加文件' });
      await s.ended;
      const events = s.lines.map((l) => JSON.parse(l) as AskEvent);
      expect(events.at(-1)).toMatchObject({ type: 'done', status: 'done' });
      const ev = proposalEvents(events);
      expect(ev.map((e) => e.proposal)).toMatchObject([{ kind: 'files', status: 'pending', root: 'repo', files: [{ path: 'notes/a.md', isNew: true }] }]);
      expect(JSON.stringify(events)).not.toContain('SECRET-CONTENT');
      const r = await apply(ev[0]!.proposal.id, {}, await repoApi(cli));
      expect(r.body.proposal.status).toBe('applied');
      expect(readFileSync(path.join(repo, 'notes/a.md'), 'utf8')).toBe('SECRET-CONTENT-1');
    } finally {
      delete process.env.FAKE_CLI_SCENARIO;
      delete process.env.FAKE_CLI_RECORD;
    }
  });
});
