import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  askSystemPrompt, buildFilesProposal, buildPullRequestProposal, rebuildProposals, ClaudeCodeClient, createLlmClient, defaultBranchName, killActiveCliProcesses,
  MAX_PROPOSAL_FILES, MAX_WRITE_ARGS_CHARS, redactWriteArgs, resetCliShutdown, runAsk, runAskTool, sha1, TOOL_LIMIT_RESULT, WRITE_TOOLS,
} from '../src/index.js';
import { toolCallFailed } from '../src/ask/cli-agent.js';
import type { AskEvent, AskOptions, AskToolContext, LlmClient } from '../src/index.js';
import { askEnv, toolContext, type AskEnv } from './helpers/ask-env.js';
import { startFakeLlm, toolResults, type FakeLlm, type FakeLlmReply, type FakeLlmRequest } from './helpers/fake-llm-server.mjs';
import { git, tempDir } from './helpers/git-repo.js';

const FAKE_CLAUDE = path.join(import.meta.dirname, 'helpers', 'fake-claude.mjs');
const GBK_BYTES = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]);
const BOM = String.fromCharCode(0xfeff);
const SECRET = 'SECRET-BODY-4242';

let env: AskEnv;
let outside: string;
let ctx: AskToolContext;
let fake: FakeLlm;
let mode: (req: FakeLlmRequest) => FakeLlmReply = () => 'ok';

beforeAll(async () => {
  process.env.CODEINSIGHT_LOG = 'silent';
  env = await askEnv((repo) => {
    mkdirSync(path.join(repo, 'notes'));
    writeFileSync(path.join(repo, 'notes', 'gbk.txt'), GBK_BYTES);
    writeFileSync(path.join(repo, 'notes', 'bom.txt'), `${BOM}first\nsecond\n`);
    writeFileSync(path.join(repo, 'notes', 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');
    writeFileSync(path.join(repo, 'notes', 'dup.txt'), 'a = 1\na = 1\n');
    writeFileSync(path.join(repo, 'notes', 'mixed.txt'), 'a\r\nb\nc\r\nd\r\n');
    writeFileSync(path.join(repo, 'app', 'stale_me.py'), 'VALUE = 1\n');
  });
  // 本地已有 origin/main 和 origin/HEAD，PR 的 edits 来源据此预演
  git(env.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(env.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  outside = tempDir('ci-write-outside-');
  writeFileSync(path.join(outside, 'exists.md'), 'old\n');
  ctx = toolContext(env, { write: { dirs: [outside] } });
  fake = await startFakeLlm({ reply: (r) => mode(r) });
});
// 同一个写入环境里的调用会叠加，每个用例用新的
beforeEach(() => {
  ctx = toolContext(env, { write: { dirs: [outside] } });
});
afterAll(async () => {
  env.store.close();
  await fake.close();
  await killActiveCliProcesses();
});

const files = (...f: Record<string, unknown>[]) => ({ summary: 'change', files: f });

describe('propose_file_changes', () => {
  it('applies edits in order on the current disk content and leaves the disk untouched', async () => {
    const before = readFileSync(path.join(env.repo, 'notes', 'bom.txt'));
    const { proposal } = await buildFilesProposal(ctx, files({ path: 'notes/bom.txt', edits: [{ old: 'first', new: 'FIRST' }, { old: 'FIRST\nsecond', new: 'both' }] }));
    expect(proposal).toMatchObject({ root: 'repo', rootPath: env.repo, summary: 'change' });
    expect(proposal.files[0]).toMatchObject({ path: 'notes/bom.txt', isNew: false, baseSha1: sha1(before) });
    expect(readFileSync(path.join(env.repo, 'notes', 'bom.txt'))).toEqual(before);
  });

  it('keeps the BOM', async () => {
    const { proposal } = await buildFilesProposal(ctx, files({ path: 'notes/bom.txt', edits: [{ old: 'second', new: '第二' }] }));
    expect(proposal.files[0]!.content).toBe(`${BOM}first\n第二\n`);
  });

  it('matches LF snippets in a CRLF file and writes CRLF back', async () => {
    const { proposal } = await buildFilesProposal(ctx, files({ path: 'notes/crlf.txt', edits: [{ old: 'one\ntwo', new: 'uno\ndos' }] }));
    expect(proposal.files[0]!.content).toBe('uno\r\ndos\r\nthree\r\n');
  });

  it('matches the original text first in files with mixed line endings', async () => {
    const { proposal } = await buildFilesProposal(ctx, files({ path: 'notes/mixed.txt', edits: [{ old: 'b\nc', new: 'B\nC' }, { old: 'd', new: 'D\nE' }] }));
    expect(proposal.files[0]!.content).toBe('a\r\nB\nC\r\nD\r\nE\r\n');
    const split = await buildFilesProposal(ctx, files({ path: 'notes/crlf.txt', edits: [{ old: '\ntwo', new: '\n2' }] }));
    expect(split.proposal.files[0]!.content).toBe('one\r\n2\r\nthree\r\n');
  });

  it('rejects a lone carriage return in old or new', async () => {
    for (const e of [{ old: 'one\rtwo', new: 'x' }, { old: 'one', new: 'x\ry' }]) {
      const r = await runAskTool(ctx, 'propose_file_changes', files({ path: 'notes/crlf.txt', edits: [e] }));
      expect(r.content).toBe('error: invalid_args: edit 1: a lone carriage return (\\r) is not allowed');
    }
  });

  it('rejects non-UTF-8 files such as GBK', async () => {
    const r = await runAskTool(ctx, 'propose_file_changes', files({ path: 'notes/gbk.txt', edits: [{ old: 'x', new: 'y' }] }));
    expect(r.error).toBe('invalid_args');
    expect(r.content).toContain('not UTF-8');
  });

  it('reports edits that are not found or not unique, naming which one', async () => {
    const missing = await runAskTool(ctx, 'propose_file_changes', files({ path: 'notes/crlf.txt', edits: [{ old: 'one', new: '1' }, { old: 'nope', new: '' }] }));
    expect(missing.content).toMatch(/^error: invalid_args: edit 2: old text not found/);
    const dup = await runAskTool(ctx, 'propose_file_changes', files({ path: 'notes/dup.txt', edits: [{ old: 'a = 1', new: 'a = 2' }] }));
    expect(dup.content).toMatch(/^error: invalid_args: edit 1: old text appears more than once/);
  });

  it('creates new files, refuses to create over existing ones and to edit missing ones', async () => {
    const ok = await runAskTool(ctx, 'propose_file_changes', files({ path: 'docs/new.md', create: '# hi\n' }));
    expect(ok.error).toBeUndefined();
    expect(ok.content).toBe('Proposal ready (change #1): 1 files. The user must review and apply it in the UI; nothing has been written yet.');
    expect(existsSync(path.join(env.repo, 'docs', 'new.md'))).toBe(false);
    expect((await runAskTool(ctx, 'propose_file_changes', files({ path: 'notes/dup.txt', create: 'x' }))).error).toBe('invalid_args');
    expect((await runAskTool(ctx, 'propose_file_changes', files({ path: 'notes/none.txt', edits: [{ old: 'a', new: 'b' }] }))).error).toBe('not_found');
  });

  it('rejects forbidden paths with write_not_allowed', async () => {
    for (const p of ['.GIT/hooks/pre-commit', '.git./config', '.husky/pre-push', 'node_modules/x.js', '../escape.txt', `.co${String.fromCharCode(0x200b)}deinsight/x`]) {
      const r = await runAskTool(ctx, 'propose_file_changes', files({ path: p, create: 'x' }));
      expect(r.error, p).toBe('write_not_allowed');
    }
  });

  it('outside the repository only creates new files', async () => {
    const created = await buildFilesProposal(ctx, { root: 'dir1', summary: 's', files: [{ path: 'sub/note.md', create: 'n\n' }] });
    expect(created.proposal).toMatchObject({ root: 'dir1', rootPath: outside, files: [{ path: 'sub/note.md', isNew: true, baseSha1: null }] });
    const edit = await runAskTool(ctx, 'propose_file_changes', { root: 'dir1', summary: 's', files: [{ path: 'exists.md', edits: [{ old: 'old', new: 'new' }] }] });
    expect(edit.error).toBe('write_not_allowed');
    const overwrite = await runAskTool(ctx, 'propose_file_changes', { root: 'dir1', summary: 's', files: [{ path: 'exists.md', create: 'x' }] });
    expect(overwrite.error).toBe('write_not_allowed');
    const unknown = await runAskTool(ctx, 'propose_file_changes', { root: 'dir2', summary: 's', files: [{ path: 'a.md', create: 'x' }] });
    expect(unknown.content).toBe('error: write_not_allowed: unknown root "dir2"; writable roots: repo, dir1');
  });

  it('marks stale snapshot content and sensitive files', async () => {
    writeFileSync(path.join(env.repo, 'app', 'stale_me.py'), 'VALUE = 2\n');
    const stale = await runAskTool(ctx, 'propose_file_changes', files({ path: 'app/stale_me.py', edits: [{ old: 'VALUE = 2', new: 'VALUE = 3' }] }));
    expect(stale.content).toContain('Note: app/stale_me.py: the file changed after indexing');
    // 新的写入环境：不叠加在上一次调用生成的内容上
    const built = await buildFilesProposal(toolContext(env, { write: { dirs: [outside] } }), files(
      { path: 'app/stale_me.py', edits: [{ old: 'VALUE = 2', new: 'VALUE = 3' }] },
      { path: 'app/orders/service.py', edits: [{ old: 'def refund(', new: 'def refund_v2(' }] },
      { path: 'codeinsight.config.json', edits: [{ old: '"overview"', new: '"overview" ' }] },
    ));
    expect(built.proposal.files.map((f) => [f.staleSnapshot, f.sensitive])).toEqual([[true, undefined], [false, undefined], [false, true]]);
    const fresh = await buildFilesProposal(ctx, files({ path: 'docs/fresh.md', create: 'x' }));
    expect(fresh.proposal.files[0]!.staleSnapshot).toBeUndefined();
  });

  it('checks argument shape, file count and total size', async () => {
    expect((await runAskTool(ctx, 'propose_file_changes', files({ path: 'a.md', create: 'x', edits: [{ old: 'a', new: 'b' }] }))).error).toBe('invalid_args');
    expect((await runAskTool(ctx, 'propose_file_changes', files({ path: 'a.md' }))).error).toBe('invalid_args');
    expect((await runAskTool(ctx, 'propose_file_changes', files({ path: 'a.md', create: 'x' }, { path: 'A.md', create: 'y' }))).content).toContain('appears twice');
    const many = Array.from({ length: MAX_PROPOSAL_FILES + 1 }, (_, i) => ({ path: `m/${i}.md`, create: 'x' }));
    expect((await runAskTool(ctx, 'propose_file_changes', files(...many))).content).toContain(`at most ${MAX_PROPOSAL_FILES} files`);
    const big = await runAskTool(ctx, 'propose_file_changes', files({ path: 'big.md', create: 'x'.repeat(MAX_WRITE_ARGS_CHARS) }));
    expect(big.content).toMatch(/^error: invalid_args: the arguments are too large .* split the change/);
  });

  it('with source sending off accepts only create', async () => {
    const off = { ...ctx, sendSource: false };
    expect((await runAskTool(off, 'propose_file_changes', files({ path: 'notes/crlf.txt', edits: [{ old: 'one', new: '1' }] }))).content).toContain('source sending is turned off');
    expect((await runAskTool(off, 'propose_file_changes', files({ path: 'docs/x.md', create: 'x' }))).error).toBeUndefined();
  });

  it('is not available without the write context', async () => {
    const r = await runAskTool(toolContext(env), 'propose_file_changes', files({ path: 'docs/x.md', create: 'x' }));
    expect(r.error).toBe('invalid_args');
    expect(r.content).toContain('unknown tool');
  });
});

describe('several write calls in one answer', () => {
  const at = Date.now();
  const write = (args: Record<string, unknown>, name = 'propose_file_changes') => ({ name, args, ok: true, at });

  it('a later call keeps editing the content proposed earlier, at tool time and when saving', async () => {
    const first = files({ path: 'notes/crlf.txt', edits: [{ old: 'two', new: 'two\nADDED' }] }, { path: 'docs/other.md', create: 'o\n' });
    const second = files({ path: 'notes/crlf.txt', edits: [{ old: 'ADDED', new: 'ADDED again' }] }, { path: 'docs/other.md', edits: [{ old: 'o', new: 'O' }] });
    expect((await runAskTool(ctx, 'propose_file_changes', first)).error).toBeUndefined();
    const r = await runAskTool(ctx, 'propose_file_changes', second);
    expect(r.error).toBeUndefined();
    expect(r.content).toMatch(/^Proposal ready \(change #2\): 2 files\./);
    expect(r.content).toContain('merged with earlier change #1 into one proposal');
    expect((await runAskTool(ctx, 'propose_file_changes', files({ path: 'docs/other.md', create: 'again' }))).content).toContain('already proposed earlier');

    const saved = await rebuildProposals(toolContext(env, { write: { dirs: [outside] } }), [write(first), write(second)]);
    // 前一次调用整条并进后一张卡片，不单独保存
    expect(saved).toHaveLength(1);
    expect(saved[0]!.kind === 'files' && saved[0]!.payload.summary).toBe('change；change');
    const files2 = saved[0]!.kind === 'files' ? saved[0]!.payload.files : [];
    expect(files2.map((f) => [f.path, f.isNew, f.content])).toEqual([
      ['notes/crlf.txt', false, 'one\r\ntwo\r\nADDED again\r\nthree\r\n'],
      ['docs/other.md', true, 'O\n'],
    ]);
    expect(files2[0]!.baseSha1).toBe(sha1(readFileSync(path.join(env.repo, 'notes', 'crlf.txt'))));
  });

  it('merges the whole earlier call, including files the later call did not touch; unrelated calls stay separate', async () => {
    const first = { summary: 'one', files: [{ path: 'notes/bom.txt', edits: [{ old: 'first', new: 'FIRST' }] }, { path: 'docs/keep.md', create: 'k' }] };
    const other = { summary: 'other', files: [{ path: 'docs/alone.md', create: 'a' }] };
    const second = { summary: 'two', files: [{ path: 'notes/bom.txt', edits: [{ old: 'FIRST', new: 'FIRST!' }] }] };
    const saved = await rebuildProposals(ctx, [write(first), write(other), write(second), { ...write(other), ok: false }]);
    expect(saved.map((p) => (p.kind === 'files' ? [p.payload.summary, p.payload.files.map((f) => f.path)] : []))).toEqual([
      ['other', ['docs/alone.md']],
      ['one；two', ['notes/bom.txt', 'docs/keep.md']],
    ]);
    expect(saved[1]!.kind === 'files' && saved[1]!.payload.files[0]!.content).toBe(`${BOM}FIRST!\nsecond\n`);
  });

  it('saves in the order the tool server ran the calls (seq), not the order they started', async () => {
    const create = files({ path: 'docs/seq.md', create: 'v1\n' });
    const edit = files({ path: 'docs/seq.md', edits: [{ old: 'v1', new: 'v2' }] });
    const saved = await rebuildProposals(ctx, [{ ...write(edit), seq: 2 }, { ...write(create), seq: 1 }]);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.kind === 'files' && saved[0]!.payload.files[0]).toMatchObject({ isNew: true, content: 'v2\n' });
  });

  it('merges a pending proposal of the same session touching the same file and marks it merged when saved', async () => {
    const sessionId = env.store.chats.createSession('merge');
    const messageId = env.store.chats.addMessage(sessionId, 'assistant', 'a', null);
    const sctx = () => toolContext(env, { write: { dirs: [outside], sessionId } });
    const [earlier] = await rebuildProposals(sctx(), [write(files({ path: 'docs/cross.md', create: 'base\n' }))]);
    const earlierId = env.store.proposals.insertMerging(sessionId, messageId, earlier!);
    const next = files({ path: 'docs/cross.md', edits: [{ old: 'base', new: 'base+' }] });
    const r = await runAskTool(sctx(), 'propose_file_changes', next);
    expect(r.content).toContain('merged with 1 pending proposal(s) from earlier answers');
    const [merged] = await rebuildProposals(sctx(), [write(next)]);
    expect(merged).toMatchObject({ mergedFrom: [earlierId], payload: { files: [{ path: 'docs/cross.md', isNew: true, content: 'base+\n' }] } });
    const id = env.store.proposals.insertMerging(sessionId, messageId, merged!);
    expect(env.store.proposals.get(earlierId)).toMatchObject({ status: 'dismissed', result: { mergedInto: id } });
    expect(env.store.proposals.get(id)?.status).toBe('pending');
    // 被并入的记录已不是 pending 时，新记录不能执行
    const late = env.store.proposals.insertMerging(sessionId, messageId, { ...merged!, mergedFrom: [earlierId] });
    expect(env.store.proposals.get(late)).toMatchObject({ status: 'failed', payload: { unbuilt: true }, result: { error: { code: 'merge_base_changed' } } });
    // 其他会话不受影响
    expect((await runAskTool(toolContext(env, { write: { dirs: [outside] } }), 'propose_file_changes', next)).error).toBe('not_found');
  });

  it('allows editing a new file proposed earlier outside the repository', async () => {
    expect((await runAskTool(ctx, 'propose_file_changes', { root: 'dir1', summary: 's', files: [{ path: 'new.md', create: 'a\n' }] })).error).toBeUndefined();
    const r = await buildFilesProposal(ctx, { root: 'dir1', summary: 's', files: [{ path: 'new.md', edits: [{ old: 'a', new: 'b' }] }] });
    expect(r.proposal.files[0]).toMatchObject({ isNew: true, content: 'b\n', baseSha1: null });
  });

  it('pull request calls on the same branch add to one pull request; other sources or bases are refused', async () => {
    const pr = (extra: Record<string, unknown>) => ({ title: 'T', body: 'b', branch: 'codeinsight/stack', ...extra });
    const first = pr({ files: [{ path: 'app/orders/service.py', edits: [{ old: 'def refund(', new: 'def refund_v2(' }] }] });
    const second = pr({ title: 'T2', files: [{ path: 'app/orders/service.py', edits: [{ old: 'def refund_v2(', new: 'def refund_v3(' }] }, { path: 'docs/pr.md', create: 'x' }] });
    await buildPullRequestProposal(ctx, first);
    const merged = await buildPullRequestProposal(ctx, second);
    expect(merged.proposal.title).toBe('T2');
    expect(merged.proposal.files!.map((f) => f.path)).toEqual(['app/orders/service.py', 'docs/pr.md']);
    expect(merged.proposal.files![0]!.content).toContain('def refund_v3(');
    expect((await runAskTool(ctx, 'propose_pull_request', pr({ fromWorkingTree: {} }))).content).toContain('already proposed in this conversation');
    expect((await runAskTool(ctx, 'propose_pull_request', pr({ base: 'release', files: [{ path: 'docs/r.md', create: 'x' }] }))).content).toContain('already proposed with base main');
    // 保存时的合并要 fetch origin，在 server 的测试里覆盖

  });
});

describe('pending pull requests of the same session', () => {
  it('a call on the same branch merges the pending edits pull request; other sources are refused', async () => {
    const sessionId = env.store.chats.createSession('pr');
    const messageId = env.store.chats.addMessage(sessionId, 'assistant', 'a', null);
    const sctx = toolContext(env, { write: { dirs: [outside], sessionId } });
    const head = git(env.repo, 'rev-parse', 'HEAD').trim();
    const file = { path: 'docs/pending-pr.md', isNew: true, content: 'p1\n', baseSha1: null };
    const pending = { title: 'Old', body: 'b', base: 'main', branch: 'codeinsight/pending', source: 'edits' as const, startCommit: head, files: [file] };
    const oldId = env.store.proposals.insert(sessionId, messageId, { kind: 'pull_request', status: 'pending', payload: pending });
    const r = await buildPullRequestProposal(sctx, { title: 'New', body: 'b', branch: 'codeinsight/pending', files: [{ path: 'docs/pending-pr.md', edits: [{ old: 'p1', new: 'p2' }] }] });
    expect(r.merge.priorIds).toEqual([oldId]);
    expect(r.proposal.files).toMatchObject([{ path: 'docs/pending-pr.md', isNew: true, content: 'p2\n' }]);
    const tree = await runAskTool(toolContext(env, { write: { dirs: [outside], sessionId } }), 'propose_pull_request', { title: 'T', body: 'b', branch: 'codeinsight/pending', fromWorkingTree: {} });
    expect(tree.content).toContain('already proposed in this conversation');
  });

  it('refuses to merge when a file of the pending pull request changed on origin/<base> since', async () => {
    const sessionId = env.store.chats.createSession('pr2');
    const messageId = env.store.chats.addMessage(sessionId, 'assistant', 'a', null);
    // 起点是另一个提交，文件在现在的 origin/main 上内容不同
    const file = { path: 'app/orders/service.py', isNew: false, content: 'x', baseSha1: 'f'.repeat(40) };
    const pending = { title: 'Old', body: 'b', base: 'main', branch: 'codeinsight/moved', source: 'edits' as const, startCommit: '0'.repeat(40), files: [file] };
    env.store.proposals.insert(sessionId, messageId, { kind: 'pull_request', status: 'pending', payload: pending });
    const r = await runAskTool(toolContext(env, { write: { dirs: [outside], sessionId } }), 'propose_pull_request', { title: 'N', body: 'b', branch: 'codeinsight/moved', files: [{ path: 'docs/n.md', create: 'n' }] });
    expect(r.content).toContain('changed on origin/main since the pull request on branch codeinsight/moved was proposed');
  });
});

describe('propose_pull_request', () => {
  const now = new Date(2026, 10, 13, 9, 5);
  const pr = (extra: Record<string, unknown>) => ({ title: 'Fix refund bug', body: 'b', ...extra });

  it('applies edits to the content on origin/<base> and fills in the default base and branch', async () => {
    const { proposal } = await buildPullRequestProposal(ctx, pr({ files: [{ path: 'app/orders/service.py', edits: [{ old: 'def refund(', new: 'def refund_v2(' }] }] }), { now });
    expect(proposal).toMatchObject({ base: 'main', branch: 'codeinsight/fix-refund-bug-202611130905', source: 'edits', startCommit: git(env.repo, 'rev-parse', 'HEAD').trim() });
    expect(proposal.files![0]!.content).toContain('def refund_v2(');
  });

  it('asks for base when the default branch of origin is not known locally', async () => {
    git(env.repo, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    try {
      const r = await runAskTool(ctx, 'propose_pull_request', pr({ fromWorkingTree: {} }));
      expect(r.error).toBe('invalid_args');
      expect(r.content).toContain('pass `base`');
    } finally {
      git(env.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    }
  });

  it('gives a clear error when origin/<base> is not available locally', async () => {
    const r = await runAskTool(ctx, 'propose_pull_request', pr({ base: 'release', files: [{ path: 'a.md', create: 'x' }] }));
    expect(r.content).toContain('origin/release is not available locally');
  });

  it('checks file targets on origin/<base>', async () => {
    expect((await runAskTool(ctx, 'propose_pull_request', pr({ files: [{ path: 'app/orders/service.py', create: 'x' }] }))).content).toContain('already exists on origin/main');
    expect((await runAskTool(ctx, 'propose_pull_request', pr({ files: [{ path: 'app/orders/service.py/x', create: 'x' }] }))).error).toBe('write_not_allowed');
    expect((await runAskTool(ctx, 'propose_pull_request', pr({ files: [{ path: '.github/hooks/../x', create: 'x' }] }))).error).toBe('write_not_allowed');
  });

  it('fromWorkingTree only checks paths and names', async () => {
    const { proposal } = await buildPullRequestProposal(ctx, pr({ fromWorkingTree: { paths: ['app'] } }), { now });
    expect(proposal).toMatchObject({ source: 'working_tree', paths: ['app'], startCommit: git(env.repo, 'rev-parse', 'HEAD').trim() });
    expect((await runAskTool(ctx, 'propose_pull_request', pr({ fromWorkingTree: { paths: ['.git/config'] } }))).error).toBe('write_not_allowed');
    expect((await runAskTool(ctx, 'propose_pull_request', pr({ fromWorkingTree: {} }))).content).toMatch(/^Proposal ready \(change #\d+\): the working tree changes, branch codeinsight\/fix-refund-bug-\d{12} -> main\./);
  });

  it('files and fromWorkingTree are mutually exclusive', async () => {
    expect((await runAskTool(ctx, 'propose_pull_request', pr({}))).content).toContain('exactly one of `files` and `fromWorkingTree`');
    expect((await runAskTool(ctx, 'propose_pull_request', pr({ files: [{ path: 'a.md', create: 'x' }], fromWorkingTree: {} }))).error).toBe('invalid_args');
  });

  it('rejects bad branch and base names', async () => {
    for (const extra of [{ branch: '-x' }, { branch: 'a b' }, { branch: 'a..b' }, { branch: 'x@{-1}' }, { branch: 'tab\tx' }, { base: '-main' }, { base: 'ma in' }, { branch: 'main' }, { branch: '@' }, { branch: 'refs/heads/x' }, { base: 'refs/x' }, { branch: 'x.lock' }]) {
      const r = await runAskTool(ctx, 'propose_pull_request', pr({ ...extra, fromWorkingTree: {} }));
      expect(r.error, JSON.stringify(extra)).toBe('invalid_args');
    }
    expect((await runAskTool(ctx, 'propose_pull_request', pr({ branch: 'feat/ok-1', fromWorkingTree: {} }))).error).toBeUndefined();
  });

  it('default branch names keep English letters and digits; Chinese titles fall back to pr', () => {
    expect(defaultBranchName('修复退款问题', now)).toBe('codeinsight/pr-202611130905');
    expect(defaultBranchName('修复 refund 问题 #12', now)).toBe('codeinsight/refund-12-202611130905');
    expect(defaultBranchName('A'.repeat(80), now)).toBe(`codeinsight/${'a'.repeat(40)}-202611130905`);
  });

  it('with source sending off accepts only fromWorkingTree', async () => {
    const off = { ...ctx, sendSource: false };
    expect((await runAskTool(off, 'propose_pull_request', pr({ files: [{ path: 'a.md', create: 'x' }] }))).content).toContain('only use fromWorkingTree');
    expect((await runAskTool(off, 'propose_pull_request', pr({ fromWorkingTree: {} }))).error).toBeUndefined();
  });
});

describe('redactWriteArgs', () => {
  it('replaces create, edits and body with character counts and keeps paths', () => {
    const edits = [{ old: 'ab', new: 'cde' }];
    expect(redactWriteArgs('propose_file_changes', { root: 'dir1', summary: 's', files: [{ path: 'a.md', create: 'hello' }, { path: 'b.md', edits }] }))
      .toEqual({ root: 'dir1', summary: 's', files: [{ path: 'a.md', create: 5 }, { path: 'b.md', edits: JSON.stringify(edits).length }] });
    expect(redactWriteArgs('propose_pull_request', { title: 't', body: 'long body', fromWorkingTree: { paths: ['x'] } })).toEqual({ title: 't', body: 9, fromWorkingTree: { paths: ['x'] } });
    const extra = redactWriteArgs('propose_file_changes', {
      summary: { text: SECRET }, content: SECRET, extra: [SECRET], root: 1,
      files: [{ path: 'a.md', content: SECRET, edits: [{ old: 'x', new: 'y', extra: SECRET }] }, SECRET, { path: { p: SECRET } }],
    });
    expect(JSON.stringify(extra)).not.toContain(SECRET);
    expect(extra.files).toEqual([{ path: 'a.md', content: SECRET.length, edits: expect.any(Number) }, SECRET.length, { path: expect.any(Number) }]);
    const pr = redactWriteArgs('propose_pull_request', { title: 't', base: 'main', branch: 'b', fromWorkingTree: { paths: ['x'], note: SECRET }, files: 'oops' });
    expect(pr).toEqual({ title: 't', base: 'main', branch: 'b', fromWorkingTree: { paths: ['x'], note: SECRET.length }, files: 4 });
    const read = { path: 'a.py' };
    expect(redactWriteArgs('read_source', read)).toBe(read);
  });
});

describe('prompt', () => {
  it('adds the write rules with directory names only when write tools are offered', () => {
    const p = askSystemPrompt({ sendSource: true, writeDirs: ['notes', 'docs'] });
    expect(p).toContain('call propose_file_changes');
    expect(p).toContain('- Writable locations: repo (this repository); dir1 (notes), dir2 (docs) (new files only). Other paths are rejected.');
    expect(askSystemPrompt({ sendSource: true })).not.toContain('propose_file_changes');
    const off = askSystemPrompt({ sendSource: false, writeDirs: [] });
    expect(off).toContain('Source sending is turned off: read_source returns only signatures');
    expect(off).toContain('propose_file_changes accepts only create');
    expect(off).not.toContain('copied from read_source');
    expect(off).toContain('- Writable locations: repo (this repository). Other paths are rejected.');
  });
});

describe('runAsk with write tools (API)', () => {
  const client = (): LlmClient => createLlmClient({ provider: 'anthropic', model: 'fake', baseUrl: fake.url, apiKey: 'k' });

  async function ask(extra: Partial<AskOptions>) {
    const events: AskEvent[] = [];
    const before = fake.requests.length;
    const result = await runAsk({
      repo: env.repo, store: env.store, layout: env.layout, config: env.config, snapshot: env.snapshot,
      client: client(), question: '加一个说明文件', onEvent: (e) => events.push(e), ...extra,
    });
    return { result, events, sent: fake.requests.slice(before) };
  }

  const toolNames = (req: FakeLlmRequest) => (req.body.tools as { name: string }[]).map((t) => t.name);

  it('offers the write tools only with a session and writeTools', async () => {
    mode = () => 'ok';
    const sessionId = env.store.chats.createSession('t');
    const withWrite = await ask({ sessionId, writeTools: { dirs: [outside] } });
    expect(toolNames(withWrite.sent[0]!)).toEqual(expect.arrayContaining(WRITE_TOOLS.map((t) => t.name)));
    expect(JSON.stringify(withWrite.sent[0]!.body.system)).toContain(`dir1 (${path.basename(outside)})`);
    const noSession = await ask({ writeTools: { dirs: [outside] } });
    expect(toolNames(noSession.sent[0]!)).not.toContain('propose_file_changes');
    expect(JSON.stringify(noSession.sent[0]!.body.system)).not.toContain('propose_file_changes');
    const noWrite = await ask({ sessionId });
    expect(toolNames(noWrite.sent[0]!)).not.toContain('propose_file_changes');
  });

  it('keeps file contents out of events and toolCalls, and keeps the raw arguments of successful calls in memory', async () => {
    mode = (req) => toolResults(req).length === 0
      ? { toolCalls: [
          { name: 'propose_file_changes', input: { summary: 's', files: [{ path: 'docs/ok.md', create: SECRET }] } },
          { name: 'propose_file_changes', input: { summary: 's', files: [{ path: '.git/x', create: `${SECRET}-2` }] } },
        ] }
      : { text: '请在页面上确认。' };
    const sessionId = env.store.chats.createSession('t');
    const { result, events, sent } = await ask({ sessionId, writeTools: { dirs: [outside] } });
    expect(toolResults(sent[1]!)[0]).toContain('Proposal ready (change #1): 1 files.');
    expect(events.filter((e) => e.type === 'tool')[0]).toEqual({ type: 'tool', name: 'propose_file_changes', args: { summary: 's', files: [{ path: 'docs/ok.md', create: SECRET.length }] } });
    expect(events.filter((e) => e.type === 'tool_done').map((e) => (e as { error?: string }).error)).toEqual([undefined, 'write_not_allowed']);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(result.meta)).not.toContain(SECRET);
    expect(JSON.stringify(env.store.chats.messages(sessionId))).not.toContain(SECRET);
    expect(result.pendingWrites.map((w) => [w.ok, (w.args.files as { create: string }[])[0]!.create])).toEqual([[true, SECRET], [false, `${SECRET}-2`]]);
  });
});

describe('runAsk with write tools (Claude Code)', () => {
  beforeEach(() => resetCliShutdown());

  it('allows the write tools, passes the write switches to the tool server and redacts the tool events', async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    process.env.CLAUDE_CONFIG_DIR = tempDir('ci-claude-cfg-');
    const recordFile = path.join(tempDir('ci-ask-write-rec-'), 'record.jsonl');
    process.env.FAKE_CLI_SCENARIO = 'stream-write';
    process.env.FAKE_CLI_RECORD = recordFile;
    const events: AskEvent[] = [];
    const sessionId = env.store.chats.createSession('t');
    const result = await runAsk({
      repo: env.repo, store: env.store, layout: env.layout, config: env.config, snapshot: env.snapshot, sessionId, writeTools: { dirs: [outside] },
      client: new ClaudeCodeClient({ command: FAKE_CLAUDE, model: '', timeoutMs: 20_000 }), question: '加文件',
      toolServer: { command: process.execPath, args: ['/opt/codeinsight/main.js', 'mcp', '--ask-tools'] }, onEvent: (e) => events.push(e),
    });
    const rec = JSON.parse(readFileSync(recordFile, 'utf8').split('\n')[0]!) as { argv: string[]; system: { content: string }; mcp: { content: { mcpServers: { codeinsight: { args: string[] } } } } };
    const opt = (name: string) => rec.argv[rec.argv.indexOf(name) + 1];
    expect(opt('--tools')).toBe('');
    expect(opt('--allowedTools')!.split(',')).toEqual(expect.arrayContaining(['mcp__codeinsight__propose_file_changes', 'mcp__codeinsight__propose_pull_request', 'mcp__codeinsight__read_source']));
    expect(rec.mcp.content.mcpServers.codeinsight.args.slice(-5)).toEqual(['--write-tools', '--writable-dir', outside, '--session', String(sessionId)]);
    expect(rec.system.content).toContain('Writable locations');
    expect(result.status).toBe('done');
    expect(JSON.stringify(events)).not.toContain('SECRET-CONTENT');
    expect(JSON.stringify(result.meta)).not.toContain('SECRET-CONTENT');
    expect(events.filter((e) => e.type === 'tool_done').map((e) => (e as { error?: string }).error)).toEqual([undefined, 'write_not_allowed']);
    expect(result.pendingWrites.map((w) => w.ok)).toEqual([true, false]);
    expect(JSON.stringify(result.pendingWrites)).toContain('SECRET-CONTENT-1');
  });

  it('saves parallel write calls in the order the tool server ran them', async () => {
    process.env.FAKE_CLI_SCENARIO = 'stream-write-parallel';
    process.env.FAKE_CLI_RECORD = path.join(tempDir('ci-ask-write-rec-'), 'record.jsonl');
    const sessionId = env.store.chats.createSession('t');
    const result = await runAsk({
      repo: env.repo, store: env.store, layout: env.layout, config: env.config, snapshot: env.snapshot, sessionId,
      writeTools: { dirs: [outside] }, client: new ClaudeCodeClient({ command: FAKE_CLAUDE, model: '', timeoutMs: 20_000 }), question: '并行',
      toolServer: { command: process.execPath, args: ['/opt/codeinsight/main.js', 'mcp', '--ask-tools'] },
    });
    expect(result.pendingWrites.map((w) => w.seq)).toEqual([2, 1]);
    const saved = env.store.proposals.listByMessages([result.messageId!]);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ status: 'pending', payload: { summary: 'create；edit', files: [{ path: 'docs/par.md', isNew: true, content: 'v2\n' }] } });
  });

  it('a result text starting with "error: " (such as skipped) does not count as success', async () => {
    process.env.FAKE_CLI_SCENARIO = 'stream-write';
    process.env.FAKE_CLI_RECORD = path.join(tempDir('ci-ask-write-rec-'), 'record.jsonl');
    process.env.FAKE_CLI_WRITE_RESULT = TOOL_LIMIT_RESULT;
    try {
      const result = await runAsk({
        repo: env.repo, store: env.store, layout: env.layout, config: env.config, snapshot: env.snapshot, sessionId: env.store.chats.createSession('t'),
        writeTools: { dirs: [outside] }, client: new ClaudeCodeClient({ command: FAKE_CLAUDE, model: '', timeoutMs: 20_000 }), question: '加文件',
        toolServer: { command: process.execPath, args: ['/opt/codeinsight/main.js', 'mcp', '--ask-tools'] },
      });
      expect(result.pendingWrites.map((w) => w.ok)).toEqual([false, false]);
    } finally {
      delete process.env.FAKE_CLI_WRITE_RESULT;
    }
    expect(toolCallFailed('<tool_use_error>error: skipped: x</tool_use_error>', false)).toBe(true);
    expect(toolCallFailed('Proposal ready: 1 files.', false)).toBe(false);
    expect(toolCallFailed('Proposal ready', true)).toBe(true);
  });
});
