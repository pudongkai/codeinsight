import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { collectWorkingTree, gitRun, proposalRef, WorkingTreeRejected, type ProposalView } from '@codeinsight/core';
import { startHttpServer, type RunningHttpServer, type ServerWorkspace } from '../src/index.js';
import { parseGitHubRemote, PR_FOOTER } from '../src/proposals/pull-request.js';
import {
  fakeLlmEnv, firstUserText, startFakeLlm, toolResults, type FakeLlm, type FakeLlmReply, type FakeLlmRequest,
} from '../../core/test/helpers/fake-llm-server.mjs';
import { apiFor, git, indexReady, openWorkspace, postStream, request, shopRepo, tempDir, writeFiles, type Api } from './helpers/env.js';

/** 一个问题：第一轮调用写工具，收到结果后给最后的回复 */
const plans = new Map<string, { name: string; input: Record<string, unknown> }[]>();
let questionNo = 0;

function reply(req: FakeLlmRequest): FakeLlmReply {
  const calls = plans.get(firstUserText(req));
  if (!calls) return 'no plan';
  return toolResults(req).length === 0 ? { toolCalls: calls } : '请在页面上确认。';
}

let fake: FakeLlm;
let repo: string;
let origin: string;
let markers: string;
let ghLog: string;
let ws: ServerWorkspace;
let server: RunningHttpServer;
let api: Api;
let mut: Api;
const savedPath = process.env.PATH;

/**
 * 假 gh：记录参数和 PR 正文；FAKE_GH_MODE 可以是 logged-out、create-fails、pr-exists、pr-merged（逗号分隔）。
 * pr view 返回的 PR 指向 FAKE_GH_HEAD_OID
 */
const FAKE_GH = `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
const mode = (process.env.FAKE_GH_MODE || '').split(',');
const rec = { args };
const out = (code, stdout, stderr) => {
  fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(rec) + '\\n');
  if (stdout) process.stdout.write(stdout + '\\n');
  if (stderr) process.stderr.write(stderr + '\\n');
  process.exit(code);
};
const [a, b] = args;
if (a === 'auth' && b === 'status') mode.includes('logged-out') ? out(1, '', 'You are not logged into any GitHub hosts.') : out(0, 'Logged in');
else if (a === 'repo' && b === 'view') out(0, JSON.stringify({ nameWithOwner: 'acme/shop', url: 'https://github.example.com/acme/shop' }));
else if (a === 'pr' && b === 'create') {
  rec.body = fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
  if (mode.includes('create-fails')) out(1, '', 'GraphQL: something went wrong');
  else if (mode.includes('pr-exists') || mode.includes('pr-merged')) out(1, '', 'a pull request for branch "x" into branch "main" already exists:');
  else out(0, 'https://github.example.com/acme/shop/pull/42');
} else if (a === 'pr' && b === 'view') {
  const state = mode.includes('pr-exists') ? 'OPEN' : mode.includes('pr-merged') ? 'MERGED' : '';
  state ? out(0, JSON.stringify({ url: 'https://github.example.com/acme/shop/pull/7', state, headRefOid: process.env.FAKE_GH_HEAD_OID })) : out(1, '', 'no pull requests found');
}
else out(2, '', 'unexpected gh call');
`;

const HOOKS = ['pre-commit', 'pre-push', 'post-checkout', 'commit-msg', 'post-commit', 'reference-transaction'];

beforeAll(async () => {
  process.env.CODEINSIGHT_LOG = 'silent';
  fake = await startFakeLlm({ reply });
  repo = realpathSync(shopRepo());
  writeFiles(repo, {
    'scripts/run.sh': '#!/bin/sh\necho old\n', 'scripts/tool.sh': '#!/bin/sh\necho tool\n',
    'docs/guide.md': 'line one\nline two\n', 'docs/old-name.md': 'renamed content\n', 'docs/remove.md': 'to remove\n',
  });
  chmodSync(path.join(repo, 'scripts/run.sh'), 0o755);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'files');
  // 服务进程用本机的 git 配置：仓库里固定身份、不签名；钩子目录固定为仓库里会写标记文件的钩子（不受全局 core.hooksPath 影响）
  git(repo, 'config', 'user.name', 'Tester');
  git(repo, 'config', 'user.email', 'tester@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  markers = realpathSync(tempDir('ci-pr-markers-'));
  const hooks = path.join(repo, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  for (const h of HOOKS) {
    writeFileSync(path.join(hooks, h), `#!/bin/sh\ntouch "${markers}/${h}"\nexit 0\n`);
    chmodSync(path.join(hooks, h), 0o755);
  }
  git(repo, 'config', 'core.hooksPath', hooks);
  origin = path.join(realpathSync(tempDir('ci-pr-origin-')), 'origin.git');
  git(path.dirname(origin), 'init', '-q', '--bare', '-b', 'main', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  // 钩子对普通的 git 命令是生效的
  expect(readdirSync(markers)).toContain('pre-push');
  rmSync(markers, { recursive: true, force: true });
  mkdirSync(markers);

  const bin = realpathSync(tempDir('ci-pr-bin-'));
  writeFileSync(path.join(bin, 'gh'), FAKE_GH);
  chmodSync(path.join(bin, 'gh'), 0o755);
  process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
  ghLog = path.join(bin, 'gh.log');
  process.env.FAKE_GH_LOG = ghLog;

  ws = await openWorkspace(repo, tempDir('ci-pr-data-'), undefined, fakeLlmEnv(fake.url));
  server = await startHttpServer({ workspace: ws });
  api = apiFor(server);
  await indexReady(api);
  const gen = (await api<{ repoGen: number }>('/api/status')).body.repoGen;
  mut = async <T>(rawPath: string, opts: { method?: string; body?: unknown } = {}) => {
    const res = await request(server.port, rawPath, { ...opts, headers: { Authorization: `Bearer ${server.token}`, 'X-CodeInsight-Repo': String(gen) } });
    return { status: res.status, body: res.body ? res.json<T>() : ({} as T) };
  };
});

afterAll(async () => {
  process.env.PATH = savedPath;
  await server?.close();
  await fake?.close();
});

afterEach(() => {
  delete process.env.FAKE_GH_MODE;
  delete process.env.FAKE_GH_HEAD_OID;
  rmSync(ghLog, { force: true });
});

/** 问一个调用 propose_pull_request 的问题，返回保存的卡片 */
async function proposePr(input: Record<string, unknown>): Promise<ProposalView> {
  const question = `q${++questionNo}`;
  plans.set(question, [{ name: 'propose_pull_request', input }]);
  const sessionId = (await api<{ id: number }>('/api/chat/sessions', { method: 'POST', body: {} })).body.id;
  const s = await postStream(server, `/api/chat/sessions/${sessionId}/messages`, { question });
  await s.ended;
  const view = (await api<{ messages: (ProposalView & { proposals?: ProposalView[] })[] }>(`/api/chat/sessions/${sessionId}`)).body;
  const proposals = view.messages[1]!.proposals!;
  expect(proposals).toHaveLength(1);
  return proposals[0]!;
}

const apply = (id: number) => mut<{ proposal: ProposalView }>(`/api/chat/proposals/${id}/apply`, { method: 'POST', body: {} });
const diffOf = (id: number) => api<{ files: { path: string; isNew: boolean; deleted?: boolean; diff: string; tooLarge?: boolean }[] }>(`/api/chat/proposals/${id}/diff`);

function ghCalls(): { args: string[]; body?: string }[] {
  try {
    return readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; body?: string });
  } catch {
    return [];
  }
}

/** 用户能看到的仓库状态：当前分支、HEAD、本地分支、索引和工作区状态 */
function userState(): Record<string, string> {
  return {
    head: git(repo, 'symbolic-ref', 'HEAD'), sha: git(repo, 'rev-parse', 'HEAD'), branches: git(repo, 'branch', '--list'),
    index: git(repo, 'ls-files', '-s'), status: git(repo, 'status', '--porcelain=v1', '-uall'),
  };
}

/** 远程仓库上分支的文件：路径 → [mode, 内容] */
function originFilesAt(remote: string, branch: string): Map<string, [string, string]> {
  const out = git(remote, 'ls-tree', '-r', '-z', `refs/heads/${branch}`).split('\0').filter(Boolean);
  return new Map(out.map((l) => {
    const [meta, p] = l.split('\t') as [string, string];
    const [mode, , oid] = meta.split(' ') as [string, string, string];
    return [p, [mode, git(remote, 'cat-file', 'blob', oid)]];
  }));
}

const originFiles = (branch: string) => originFilesAt(origin, branch);

const hasRef = (id: number) => git(repo, 'for-each-ref', proposalRef(ws.layout.root, id)).trim() !== '';

describe('creating a pull request from edits', () => {
  it('commits on top of origin/<base> without touching the working tree, pushes and opens the PR', async () => {
    const pr = await proposePr({
      title: '-Fix guide', body: 'Explains the fix.', base: 'main', branch: 'codeinsight/fix-guide',
      files: [
        { path: 'docs/guide.md', edits: [{ old: 'line two', new: 'line 2' }] },
        { path: 'scripts/run.sh', edits: [{ old: 'echo old', new: 'echo new' }] },
        { path: 'docs/added.md', create: 'added\n' },
      ],
    });
    expect(pr).toMatchObject({ kind: 'pull_request', status: 'pending', source: 'edits', base: 'main', branch: 'codeinsight/fix-guide' });
    const diff = await diffOf(pr.id);
    expect(diff.body.files.find((f) => f.path === 'docs/guide.md')!.diff).toContain('-line two\n+line 2');

    const before = userState();
    const r = await apply(pr.id);
    expect(r.status).toBe(200);
    expect(r.body.proposal).toMatchObject({ status: 'applied', pushed: true, result: { url: 'https://github.example.com/acme/shop/pull/42' } });
    expect(userState()).toEqual(before);
    expect(readdirSync(markers)).toEqual([]);

    const files = originFiles('codeinsight/fix-guide');
    expect(files.get('docs/guide.md')).toEqual(['100644', 'line one\nline 2\n']);
    expect(files.get('scripts/run.sh')).toEqual(['100755', '#!/bin/sh\necho new\n']);
    expect(files.get('docs/added.md')).toEqual(['100644', 'added\n']);
    const commit = git(origin, 'rev-parse', 'refs/heads/codeinsight/fix-guide').trim();
    expect(git(origin, 'rev-parse', `${commit}^`).trim()).toBe(git(repo, 'rev-parse', 'origin/main').trim());
    expect(git(origin, 'log', '-1', '--format=%s|%an', commit).trim()).toBe('-Fix guide|Tester');

    const calls = ghCalls();
    expect(calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['repo view', 'auth status', 'pr create']);
    expect(calls[1]!.args).toEqual(['auth', 'status', '--hostname', 'github.example.com']);
    expect(calls[2]!.args).toEqual(expect.arrayContaining(['--repo=acme/shop', '--base=main', '--head=codeinsight/fix-guide', '--title=-Fix guide']));
    expect(calls[2]!.body).toBe(`Explains the fix.\n\n---\n${PR_FOOTER}\n`);
  });
});

describe('creating a pull request from the working tree', () => {
  it('saves a tree of the uncommitted changes, shows the diff and pushes exactly that tree', async () => {
    writeFiles(repo, { 'docs/local.md': 'local commit\n' });
    git(repo, 'add', 'docs/local.md');
    git(repo, 'commit', '-q', '--no-verify', '-m', 'Local only commit');
    rmSync(markers, { recursive: true, force: true });
    mkdirSync(markers);
    const outside = path.join(realpathSync(tempDir('ci-pr-outside-')), 'secret.txt');
    writeFileSync(outside, 'OUTSIDE-SECRET\n');
    writeFiles(repo, { 'docs/guide.md': 'line one\nline two changed\n', 'docs/untracked.md': 'new file\n', 'ignored.txt': 'ignored\n' });
    writeFileSync(path.join(repo, '.git', 'info', 'exclude'), 'ignored.txt\n');
    renameSync(path.join(repo, 'docs/old-name.md'), path.join(repo, 'docs/new-name.md'));
    rmSync(path.join(repo, 'docs/remove.md'));
    chmodSync(path.join(repo, 'scripts/tool.sh'), 0o755);
    symlinkSync(outside, path.join(repo, 'docs/link'));

    const beforeSave = userState();
    const indexBytes = readFileSync(path.join(repo, '.git', 'index'));
    const pr = await proposePr({ title: 'From tree', body: '', base: 'main', branch: 'codeinsight/from-tree', fromWorkingTree: {} });
    expect(readFileSync(path.join(repo, '.git', 'index')).equals(indexBytes)).toBe(true);
    expect(userState()).toEqual(beforeSave);
    expect(pr).toMatchObject({ status: 'pending', source: 'working_tree', unpushedCommits: ['Local only commit'] });
    expect(pr.files).toEqual([
      { path: 'docs/guide.md', isNew: false }, { path: 'docs/link', isNew: true }, { path: 'docs/new-name.md', isNew: true },
      { path: 'docs/old-name.md', isNew: false, deleted: true }, { path: 'docs/remove.md', isNew: false, deleted: true },
      { path: 'docs/untracked.md', isNew: true }, { path: 'scripts/tool.sh', isNew: false },
    ]);
    const tree = ws.store.proposals.get(pr.id)!.payload as { tree: string; startCommit: string };
    expect(tree.startCommit).toBe(git(repo, 'rev-parse', 'HEAD').trim());
    expect(proposalRef(ws.layout.root, pr.id)).toMatch(new RegExp(`^refs/codeinsight/proposals/[0-9a-f]{12}/${pr.id}$`));
    expect(git(repo, 'rev-parse', proposalRef(ws.layout.root, pr.id)).trim()).toBe(tree.tree);

    const diff = await diffOf(pr.id);
    expect(diff.status).toBe(200);
    expect(diff.body.files.map((f) => f.path)).toEqual(pr.files.map((f) => f.path));
    expect(diff.body.files[0]!.diff).toMatch(/^--- a\/docs\/guide.md\n\+\+\+ b\/docs\/guide.md\n@@/);
    expect(diff.body.files[0]!.diff).toContain('-line two\n+line two changed');
    expect(diff.body.files.find((f) => f.path === 'docs/remove.md')).toMatchObject({ deleted: true });
    expect(JSON.stringify(diff.body)).not.toContain('OUTSIDE-SECRET');

    const before = userState();
    const r = await apply(pr.id);
    expect(r.body.proposal).toMatchObject({ status: 'applied', result: { url: 'https://github.example.com/acme/shop/pull/42' } });
    expect(userState()).toEqual(before);
    expect(readdirSync(markers)).toEqual([]);
    expect(hasRef(pr.id)).toBe(false);

    const files = originFiles('codeinsight/from-tree');
    expect(files.get('docs/link')).toEqual(['120000', outside]);
    expect(files.get('scripts/tool.sh')![0]).toBe('100755');
    expect(files.get('docs/new-name.md')).toEqual(['100644', 'renamed content\n']);
    expect(files.has('docs/old-name.md')).toBe(false);
    expect(files.has('docs/remove.md')).toBe(false);
    expect(files.has('ignored.txt')).toBe(false);
    expect(files.get('docs/local.md')).toEqual(['100644', 'local commit\n']);
    const commit = git(origin, 'rev-parse', 'refs/heads/codeinsight/from-tree').trim();
    expect(git(origin, 'rev-parse', `${commit}^`).trim()).toBe(tree.startCommit);
    expect(ghCalls().at(-1)!.body).toBe(`${PR_FOOTER}\n`);
  });

  it('only includes the given paths and deletes the reference when dismissed', async () => {
    const pr = await proposePr({ title: 'Only guide', base: 'main', branch: 'codeinsight/only-guide', fromWorkingTree: { paths: ['docs/guide.md'] } });
    expect(pr.files).toEqual([{ path: 'docs/guide.md', isNew: false }]);
    expect(hasRef(pr.id)).toBe(true);
    const r = await mut<{ proposal: ProposalView }>(`/api/chat/proposals/${pr.id}/dismiss`, { method: 'POST', body: {} });
    expect(r.body.proposal.status).toBe('dismissed');
    expect(hasRef(pr.id)).toBe(false);
  });

  it('shows a type change as one file and a mode-only change with its modes', async () => {
    rmSync(path.join(repo, 'scripts/run.sh'));
    symlinkSync('tool.sh', path.join(repo, 'scripts/run.sh'));
    const pr = await proposePr({ title: 'Types', base: 'main', branch: 'codeinsight/types', fromWorkingTree: { paths: ['scripts/run.sh', 'scripts/tool.sh'] } });
    expect(pr.files).toEqual([{ path: 'scripts/run.sh', isNew: false }, { path: 'scripts/tool.sh', isNew: false }]);
    const diff = await diffOf(pr.id);
    expect(diff.status).toBe(200);
    const [link, mode] = diff.body.files;
    expect(link!.diff).toContain('deleted file mode 100755');
    expect(link!.diff).toContain('-echo old');
    expect(link!.diff).toContain('new file mode 120000');
    expect(link!.diff).toContain('+tool.sh');
    expect(mode!.diff).toBe('old mode 100644\nnew mode 100755\n');
  });

  it('deletes the references of the session when the session is deleted', async () => {
    const pr = await proposePr({ title: 'Session', base: 'main', branch: 'codeinsight/session', fromWorkingTree: { paths: ['docs/guide.md'] } });
    expect(hasRef(pr.id)).toBe(true);
    const sessionId = ws.store.proposals.get(pr.id)!.sessionId;
    expect((await api(`/api/chat/sessions/${sessionId}`, { method: 'DELETE' })).status).toBe(200);
    expect(hasRef(pr.id)).toBe(false);
  });
});

describe('failures and retries', () => {
  it('continues after a failed gh pr create without committing or pushing again, and uses an existing PR', async () => {
    const pr = await proposePr({ title: 'Retry', base: 'main', branch: 'codeinsight/retry', files: [{ path: 'docs/retry.md', create: 'retry\n' }] });
    process.env.FAKE_GH_MODE = 'create-fails';
    const failed = await apply(pr.id);
    expect(failed.body.proposal).toMatchObject({ status: 'failed', pushed: true, result: { error: { code: 'pr_create_failed' } } });
    expect(failed.body.proposal.result!.error!.message).toContain('GraphQL: something went wrong');
    const pushed = git(origin, 'rev-parse', 'refs/heads/codeinsight/retry').trim();
    expect(ws.store.proposals.get(pr.id)!.progress).toEqual({ commit: pushed, pushed: true });

    // 同名分支上已合并的旧 PR 不能当作本次的结果
    process.env.FAKE_GH_HEAD_OID = pushed;
    process.env.FAKE_GH_MODE = 'pr-merged';
    const merged = await apply(pr.id);
    expect(merged.body.proposal).toMatchObject({ status: 'failed', result: { error: { code: 'pr_create_failed' } } });
    process.env.FAKE_GH_HEAD_OID = '0'.repeat(40);
    process.env.FAKE_GH_MODE = 'pr-exists';
    expect((await apply(pr.id)).body.proposal.status).toBe('failed');

    process.env.FAKE_GH_HEAD_OID = pushed;
    const again = await apply(pr.id);
    expect(ghCalls().filter((c) => c.args[1] === 'view').at(-1)!.args).toEqual(['pr', 'view', '--repo=acme/shop', '--json', 'url,state,headRefOid', '--', 'codeinsight/retry']);
    expect(again.body.proposal).toMatchObject({ status: 'applied', result: { url: 'https://github.example.com/acme/shop/pull/7' } });
    expect(git(origin, 'rev-parse', 'refs/heads/codeinsight/retry').trim()).toBe(pushed);
    expect(ws.store.proposals.get(pr.id)!.progress).toEqual({ commit: pushed, pushed: true });
  });

  it('fails when the branch already exists on origin with other content', async () => {
    const other = tempDir('ci-pr-clone-');
    git(other, 'clone', '-q', origin, '.');
    writeFiles(other, { 'docs/taken.md': 'someone else\n' });
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'taken');
    git(other, 'push', '-q', 'origin', 'HEAD:refs/heads/codeinsight/taken');
    const theirs = git(origin, 'rev-parse', 'refs/heads/codeinsight/taken').trim();
    const pr = await proposePr({ title: 'Taken', base: 'main', branch: 'codeinsight/taken', files: [{ path: 'docs/mine.md', create: 'mine\n' }] });
    const r = await apply(pr.id);
    expect(r.body.proposal).toMatchObject({ status: 'failed', result: { error: { code: 'branch_exists' } } });
    expect(git(origin, 'rev-parse', 'refs/heads/codeinsight/taken').trim()).toBe(theirs);
    expect(ghCalls().some((c) => c.args[1] === 'create')).toBe(false);
  });

  it('fails before committing when gh is not logged in', async () => {
    const pr = await proposePr({ title: 'Logged out', base: 'main', branch: 'codeinsight/logged-out', files: [{ path: 'docs/lo.md', create: 'x\n' }] });
    process.env.FAKE_GH_MODE = 'logged-out';
    const r = await apply(pr.id);
    expect(r.body.proposal).toMatchObject({ status: 'failed', result: { error: { code: 'gh_not_authenticated' } } });
    expect(r.body.proposal.result!.error!.message).toContain('github.example.com');
    expect(git(origin, 'branch', '--list', 'codeinsight/logged-out').trim()).toBe('');
    expect(ws.store.proposals.get(pr.id)!.progress).toBeNull();
  });

  it('rejects branch and base names starting with - at apply time', async () => {
    for (const [key, value] of [['branch', '-delete'], ['base', '--upload-pack=x']] as const) {
      const pr = await proposePr({ title: `Bad ${key}`, base: 'main', branch: `codeinsight/bad-${key}`, files: [{ path: `docs/bad-${key}.md`, create: 'x\n' }] });
      ws.store.db.prepare('UPDATE chat_proposals SET payload = json_set(payload, ?, ?) WHERE id = ?').run(`$.${key}`, value, pr.id);
      const r = await apply(pr.id);
      expect(r.body.proposal).toMatchObject({ status: 'failed', result: { error: { code: 'invalid_args' } } });
      expect(ghCalls()).toEqual([]);
    }
  });
});

describe('the GitHub repository of origin', () => {
  it('parses the host and owner/name from the raw origin URL before asking gh', async () => {
    git(repo, 'remote', 'set-url', 'origin', 'https://github.com/acme/shop.git');
    git(repo, 'config', `url.${origin}.insteadOf`, 'https://github.com/acme/shop.git');
    try {
      const pr = await proposePr({ title: 'Parsed', base: 'main', branch: 'codeinsight/parsed', files: [{ path: 'docs/parsed.md', create: 'x\n' }] });
      const r = await apply(pr.id);
      expect(r.body.proposal.status).toBe('applied');
      const calls = ghCalls();
      expect(calls.some((c) => c.args[0] === 'repo')).toBe(false);
      expect(calls[0]!.args).toEqual(['auth', 'status', '--hostname', 'github.com']);
      expect(calls[1]!.args).toContain('--repo=acme/shop');
    } finally {
      git(repo, 'remote', 'set-url', 'origin', origin);
      git(repo, 'config', '--unset', `url.${origin}.insteadOf`);
    }
  });

  it('pushes to the push URL of origin and opens the PR from owner:branch when it is another repository', async () => {
    const fork = path.join(realpathSync(tempDir('ci-pr-fork-')), 'fork.git');
    git(path.dirname(fork), 'init', '-q', '--bare', '-b', 'main', fork);
    git(repo, 'remote', 'set-url', 'origin', 'https://github.com/acme/shop.git');
    git(repo, 'config', `url.${origin}.insteadOf`, 'https://github.com/acme/shop.git');
    git(repo, 'config', 'remote.origin.pushurl', 'https://github.com/someone/shop.git');
    git(repo, 'config', `url.${fork}.insteadOf`, 'https://github.com/someone/shop.git');
    // origin 上已有同名分支：检查的若是 origin 会报分支已存在
    git(origin, 'branch', 'codeinsight/forked', 'main');
    try {
      const pr = await proposePr({ title: 'Forked', base: 'main', branch: 'codeinsight/forked', files: [{ path: 'docs/forked.md', create: 'x\n' }] });
      const r = await apply(pr.id);
      expect(r.body.proposal.status).toBe('applied');
      expect(originFilesAt(fork, 'codeinsight/forked').get('docs/forked.md')).toEqual(['100644', 'x\n']);
      expect(git(origin, 'rev-parse', 'codeinsight/forked').trim()).toBe(git(origin, 'rev-parse', 'main').trim());
      const create = ghCalls().find((c) => c.args[1] === 'create')!;
      expect(create.args).toEqual(expect.arrayContaining(['--repo=acme/shop', '--head=someone:codeinsight/forked']));
    } finally {
      git(repo, 'remote', 'set-url', 'origin', origin);
      git(repo, 'config', '--unset', 'remote.origin.pushurl');
      git(repo, 'config', '--unset', `url.${origin}.insteadOf`);
      git(repo, 'config', '--unset', `url.${fork}.insteadOf`);
    }
  });

  it('parses common remote URL forms and leaves ssh aliases to gh', () => {
    expect(parseGitHubRemote('git@github.com:acme/shop.git')).toEqual({ host: 'github.com', repo: 'acme/shop' });
    expect(parseGitHubRemote('ssh://git@ssh.github.com:443/acme/shop.git')).toEqual({ host: 'github.com', repo: 'acme/shop' });
    expect(parseGitHubRemote('https://ghe.example.com/acme/shop')).toEqual({ host: 'ghe.example.com', repo: 'acme/shop' });
    expect(parseGitHubRemote('work:acme/shop.git')).toBeUndefined();
    expect(parseGitHubRemote('/tmp/origin.git')).toBeUndefined();
    expect(parseGitHubRemote('https://github.com/acme/-shop')).toBeUndefined();
  });
});

describe('collecting uncommitted changes', () => {
  /** 一个提交过 a.md、b.md、c.md 的仓库 */
  function smallRepo(): string {
    const r = realpathSync(tempDir('ci-pr-collect-'));
    git(r, 'init', '-q', '-b', 'main');
    writeFiles(r, { 'a.md': 'a\n', 'b.md': 'b\n', 'c.md': 'c\n' });
    git(r, 'add', '-A');
    git(r, 'commit', '-q', '-m', 'init');
    return r;
  }

  async function collect(r: string, paths: string[] = [], excludeDir?: string) {
    const run = await gitRun(r);
    return collectWorkingTree(run, path.join(tempDir('ci-pr-index-'), 'index'), git(r, 'rev-parse', 'HEAD').trim(), paths, excludeDir);
  }

  it('leaves the data directory inside the repository out of the tree and the object store', async () => {
    const r = smallRepo();
    writeFiles(r, { 'a.md': 'changed\n', '.ci-data/db': 'DATABASE-CONTENT\n', '*': 'star\n' });
    const { changes } = await collect(r, [], '.ci-data');
    expect(changes.map((c) => c.path)).toEqual(['*', 'a.md']);
    const dbBlob = git(r, 'hash-object', '.ci-data/db').trim();
    expect(() => git(r, 'cat-file', '-e', dbBlob)).toThrow();
    expect(git(r, 'status', '--porcelain')).toContain('?? .ci-data/');
  });

  it('starts from the user index: keeps skip-worktree / assume-unchanged files and staged changes, and leaves the index alone', async () => {
    const r = smallRepo();
    git(r, 'update-index', '--skip-worktree', 'a.md');
    git(r, 'update-index', '--assume-unchanged', 'b.md');
    rmSync(path.join(r, 'a.md'));
    writeFiles(r, { 'b.md': 'local b\n', 'c.md': 'staged c\n', 'd.md': 'new d\n' });
    git(r, 'add', 'c.md');
    const index = readFileSync(path.join(r, '.git', 'index'));
    const all = await collect(r);
    expect(all.changes.map((c) => `${c.status} ${c.path}`)).toEqual(['M c.md', 'A d.md']);
    expect(readFileSync(path.join(r, '.git', 'index')).equals(index)).toBe(true);
    // 只要部分路径时，其他路径上已暂存的改动不带上
    const some = await collect(r, ['d.md']);
    expect(some.changes.map((c) => `${c.status} ${c.path}`)).toEqual(['A d.md']);
    expect(readFileSync(path.join(r, '.git', 'index')).equals(index)).toBe(true);
  });

  it('does not run the fsmonitor of the user', async () => {
    const r = smallRepo();
    const marker = path.join(realpathSync(tempDir('ci-pr-fsmon-')), 'ran');
    writeFileSync(path.join(r, 'fsmonitor.sh'), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    chmodSync(path.join(r, 'fsmonitor.sh'), 0o755);
    git(r, 'config', 'core.fsmonitor', path.join(r, 'fsmonitor.sh'));
    writeFiles(r, { 'a.md': 'changed\n' });
    await collect(r);
    expect(readdirSync(path.dirname(marker))).toEqual([]);
  });

  it('rejects files stored with Git LFS and nested repositories', async () => {
    const lfs = smallRepo();
    writeFiles(lfs, { '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n', 'big.bin': 'data\n' });
    await expect(collect(lfs)).rejects.toMatchObject({ code: 'lfs_not_supported' });
    await expect(collect(lfs)).rejects.toBeInstanceOf(WorkingTreeRejected);

    const nested = smallRepo();
    const sub = path.join(nested, 'sub');
    mkdirSync(sub);
    git(sub, 'init', '-q', '-b', 'main');
    writeFiles(sub, { 'x.md': 'x\n' });
    git(sub, 'add', '-A');
    git(sub, 'commit', '-q', '-m', 'sub');
    await expect(collect(nested)).rejects.toMatchObject({ code: 'nested_repository' });
  });
});
