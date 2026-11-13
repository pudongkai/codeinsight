import type { AskEvent, ProposalView } from '@codeinsight/core/ask/events';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api/client';
import type { ChatSessionDetail } from '../src/api/types';
import { NavContext } from '../src/app/nav';
import { applyEvent, emptyAnswer, savedAnswer, type ToolStep } from '../src/chat/answer';
import { ChatPage } from '../src/chat/ChatPage';
import { NOTICE_KEY } from '../src/chat/notice';
import { ProposalCard } from '../src/chat/ProposalCard';
import { proposalErrorText } from '../src/chat/proposal-text';
import { TOOL_ERROR_LABELS, toolLabel } from '../src/chat/tool-labels';
import { stepsTitle, ToolSteps } from '../src/chat/ToolSteps';
import { makeNav, makeStatus } from './fixtures';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

function proposal(extra: Partial<ProposalView> = {}): ProposalView {
  return {
    id: 5, messageId: 2, kind: 'files', status: 'pending', summary: '修正退款金额', root: 'repo', createdAt: 1, updatedAt: 1,
    files: [{ path: 'app/pay.py', isNew: false, staleSnapshot: false }, { path: 'docs/new.md', isNew: true }],
    ...extra,
  };
}

/** 一个可以由测试控制何时完成的 Promise */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const card = () => screen.getByTestId('proposal-card');
/** apply 冲突时的 409：错误码为第一个冲突文件的原因 */
const conflictError = (files: { path: string; code: string; canForce: boolean }[], p: ProposalView) =>
  new ApiError(409, files[0]!.code, `${files[0]!.code}: files changed since the proposal was made`, { files, proposal: p });

describe('proposal events and tool steps', () => {
  it('adds proposals to the answer and replaces one with the same id', () => {
    const events: AskEvent[] = [
      { type: 'proposal', proposal: proposal() },
      { type: 'proposal', proposal: proposal({ id: 6, summary: '另一处' }) },
      { type: 'proposal', proposal: proposal({ summary: '更新后' }) },
    ];
    const a = events.reduce(applyEvent, emptyAnswer());
    expect(a.proposals.map((p) => [p.id, p.summary])).toEqual([[5, '更新后'], [6, '另一处']]);
    expect(savedAnswer('答案', null, [proposal()]).proposals).toHaveLength(1);
    expect(savedAnswer('答案', null).proposals).toEqual([]);
  });

  it('describes write tools and counts generated proposals separately in the title', () => {
    expect(toolLabel('propose_file_changes', { summary: '修正金额', files: [{ path: 'a.py' }, { path: 'b.py' }] })).toBe('生成待确认修改 修正金额（2 个文件）');
    expect(toolLabel('propose_pull_request', { title: '修复退款' })).toBe('生成待确认 PR 修复退款');
    const step = (name: string, error?: ToolStep['error']): ToolStep => ({ name, args: {}, done: true, error });
    const reads = Array.from({ length: 5 }, () => step('search_symbols'));
    expect(stepsTitle([...reads, step('propose_file_changes')], [proposal()])).toBe('查询了 5 次代码索引，生成了 1 个待确认修改');
    // 两次调用合并成了一张卡片：按卡片数说
    expect(stepsTitle([step('propose_file_changes'), step('propose_file_changes')], [proposal()])).toBe('生成了 1 个待确认修改');
    expect(stepsTitle([step('propose_file_changes'), step('propose_file_changes')], [proposal(), proposal({ id: 6, status: 'failed', unbuilt: true })])).toBe('生成了 1 个待确认修改，1 个修改没能生成');
    expect(stepsTitle([step('propose_file_changes', 'invalid_args')], [])).toBe('1 个修改没能生成');
    expect(stepsTitle(reads, [])).toBe('查询了 5 次代码索引');
    // 还在回答：卡片还没到
    const running: ToolStep = { name: 'propose_file_changes', args: {}, done: false };
    expect(stepsTitle([...reads, running])).toBe('查询了 5 次代码索引');
    expect(stepsTitle([...reads, step('propose_file_changes')])).toBe('查询了 5 次代码索引，正在生成待确认修改');
  });

  it('tool steps and proposal results use the same wording for shared error codes', () => {
    const step: ToolStep = { name: 'propose_file_changes', args: { summary: 'x' }, done: true, error: 'write_not_allowed' };
    render(<ToolSteps tools={[step]} answering={false} proposals={[]} />);
    expect(screen.getByTestId('tool-step').textContent).toContain(`（${proposalErrorText('write_not_allowed')}）`);
    expect(proposalErrorText('not_found')).toBe(TOOL_ERROR_LABELS.not_found);
  });
});

describe('ProposalCard (files)', () => {
  it('pending: title, file marks and the diff loaded on demand', async () => {
    const diff = vi.spyOn(api, 'proposalDiff').mockResolvedValue({
      files: [
        { path: 'app/pay.py', isNew: false, diff: '--- a/app/pay.py\n+++ b/app/pay.py\n@@ -1 +1 @@\n-a = 1\n+a = 2\n', changedSinceProposal: true },
        { path: 'big.bin', isNew: false, diff: '', tooLarge: true },
      ],
    });
    const files = [
      { path: 'app/pay.py', isNew: false, staleSnapshot: true }, { path: 'app/unindexed.py', isNew: false },
      { path: '.env', isNew: true, sensitive: true },
    ];
    render(<ProposalCard proposal={proposal({ files })} />);
    expect(card().querySelector('.proposal-title')!.textContent).toBe('修改 3 个文件 · 写入 当前仓库');
    const items = screen.getAllByTestId('proposal-file');
    expect(within(items[0]!).getByTestId('file-stale').textContent).toBe('助手读到的是建索引时的旧内容');
    expect(within(items[1]!).getByTestId('file-unread').textContent).toBe('未读取过原文');
    expect(within(items[2]!).getByTestId('file-sensitive')).toBeTruthy();
    expect(items[2]!.textContent).toContain('新建');
    expect(diff).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('proposal-diff-toggle'));
    await screen.findAllByTestId('diff-file');
    expect(diff).toHaveBeenCalledWith(5);
    const body = screen.getByTestId('diff-body');
    expect([...body.children].map((l) => l.className)).toEqual(['diff-meta', 'diff-meta', 'diff-hunk', 'diff-del', 'diff-add']);
    expect(screen.getByTestId('diff-changed')).toBeTruthy();
    expect(screen.getByTestId('diff-too-large').textContent).toBe('文件太大，不显示对比');
    fireEvent.click(screen.getByTestId('proposal-diff-toggle'));
    fireEvent.click(screen.getByTestId('proposal-diff-toggle'));
    expect(diff).toHaveBeenCalledTimes(1);
  });

  it('a writable directory shows its name and has no unread mark', () => {
    render(<ProposalCard proposal={proposal({ root: 'dir1', rootDir: 'notes', files: [{ path: 'a.md', isNew: true }] })} />);
    expect(card().querySelector('.proposal-title')!.textContent).toBe('修改 1 个文件 · 写入 notes');
  });

  it('applying disables the buttons, then shows the written files', async () => {
    const d = deferred<{ proposal: ProposalView }>();
    const apply = vi.spyOn(api, 'applyProposal').mockReturnValue(d.promise);
    render(<ProposalCard proposal={proposal()} />);
    fireEvent.click(screen.getByTestId('proposal-apply'));
    expect(apply).toHaveBeenCalledWith(5, false);
    expect(screen.getByTestId('proposal-apply')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('proposal-dismiss')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('proposal-result').textContent).toBe('正在写入…');
    await act(async () => d.resolve({ proposal: proposal({ status: 'applied', updatedAt: 2, result: { written: ['app/pay.py', 'docs/new.md'] } }) }));
    expect(card().dataset.status).toBe('applied');
    expect(screen.getByTestId('proposal-result').textContent).toBe('已写入app/pay.pydocs/new.md');
    expect(screen.queryByTestId('proposal-apply')).toBeNull();
    expect(screen.queryByTestId('proposal-diff-toggle')).toBeNull();
  });

  it('applying started elsewhere shows progress without buttons', () => {
    render(<ProposalCard proposal={proposal({ status: 'applying' })} />);
    expect(screen.getByTestId('proposal-result').textContent).toBe('正在写入…');
    expect(screen.queryByTestId('proposal-apply')).toBeNull();
  });

  it('failed shows the reason and the files written before, and can be retried', async () => {
    const failed = proposal({ status: 'failed', result: { written: ['app/pay.py'], error: { code: 'write_failed', message: 'writing failed (EACCES)' } } });
    const apply = vi.spyOn(api, 'applyProposal').mockResolvedValue({ proposal: proposal({ status: 'applied', updatedAt: 3, result: { written: ['app/pay.py', 'docs/new.md'] } }) });
    render(<ProposalCard proposal={failed} />);
    const result = screen.getByTestId('proposal-result').textContent!;
    expect(result).toContain('失败：写入失败（writing failed (EACCES)）');
    expect(result).toContain('失败前已写入');
    expect(screen.getByTestId('proposal-apply').textContent).toBe('重试');
    fireEvent.click(screen.getByTestId('proposal-apply'));
    await waitFor(() => expect(card().dataset.status).toBe('applied'));
    expect(apply).toHaveBeenCalledWith(5, false);
  });

  it('an interrupted run says so and can be retried', () => {
    render(<ProposalCard proposal={proposal({ status: 'failed', result: { error: { code: 'interrupted', message: '执行中断' } } })} />);
    expect(screen.getByTestId('proposal-result').textContent).toBe('失败：执行中断');
    expect(screen.getByTestId('proposal-apply').textContent).toBe('重试');
  });

  it('an applying record that has not been updated for too long can be retried or dismissed', async () => {
    const stuck = proposal({ status: 'applying', retryable: true });
    const apply = vi.spyOn(api, 'applyProposal').mockResolvedValue({ proposal: proposal({ status: 'applied', updatedAt: 3, result: { written: ['app/pay.py'] } }) });
    render(<ProposalCard proposal={stuck} />);
    expect(screen.getByTestId('proposal-result').textContent).toContain('可以重试或忽略');
    expect(screen.getByTestId('proposal-apply').textContent).toBe('重试');
    expect(screen.getByTestId('proposal-dismiss')).toBeTruthy();
    fireEvent.click(screen.getByTestId('proposal-apply'));
    await waitFor(() => expect(card().dataset.status).toBe('applied'));
    expect(apply).toHaveBeenCalledWith(5, false);
  });

  it('a card merged into a later change says so', () => {
    render(<ProposalCard proposal={proposal({ status: 'dismissed', result: { mergedInto: 9 } })} />);
    expect(screen.getByTestId('proposal-result').textContent).toBe('已并入后面的修改');
    expect(screen.queryByTestId('proposal-apply')).toBeNull();
  });

  it('dismiss marks the card as ignored', async () => {
    vi.spyOn(api, 'dismissProposal').mockResolvedValue({ proposal: proposal({ status: 'dismissed', updatedAt: 2 }) });
    render(<ProposalCard proposal={proposal()} />);
    fireEvent.click(screen.getByTestId('proposal-dismiss'));
    await waitFor(() => expect(screen.getByTestId('proposal-result').textContent).toBe('已忽略'));
    expect(screen.queryByTestId('proposal-apply')).toBeNull();
  });

  it('a conflict lists the files and "仍然写入" resends with force', async () => {
    const apply = vi.spyOn(api, 'applyProposal')
      .mockRejectedValueOnce(conflictError([{ path: 'app/pay.py', code: 'file_changed_since_proposal', canForce: true }], proposal()))
      .mockResolvedValueOnce({ proposal: proposal({ status: 'applied', updatedAt: 2, result: { written: ['app/pay.py'] } }) });
    render(<ProposalCard proposal={proposal()} />);
    fireEvent.click(screen.getByTestId('proposal-apply'));
    const item = await screen.findByTestId('conflict-file');
    expect(item.textContent).toBe('app/pay.py：生成修改后文件被改过，仍然写入会覆盖这些改动');
    expect(screen.queryByTestId('proposal-error')).toBeNull();
    fireEvent.click(screen.getByTestId('proposal-force'));
    await waitFor(() => expect(card().dataset.status).toBe('applied'));
    expect(apply).toHaveBeenLastCalledWith(5, true);
    expect(screen.queryByTestId('proposal-conflicts')).toBeNull();
  });

  it('a conflict that cannot be forced explains why and offers no force button', async () => {
    const p = proposal({ root: 'dir1', rootDir: 'notes', files: [{ path: 'a.md', isNew: true }] });
    vi.spyOn(api, 'applyProposal').mockRejectedValue(conflictError([{ path: 'a.md', code: 'file_exists', canForce: false }], p));
    render(<ProposalCard proposal={p} />);
    fireEvent.click(screen.getByTestId('proposal-apply'));
    expect((await screen.findByTestId('conflict-file')).textContent).toContain('仓库以外的目录只能新建文件，不能覆盖');
    expect(screen.queryByTestId('proposal-force')).toBeNull();
    expect(screen.getByTestId('proposal-no-force')).toBeTruthy();
  });

  it('a proposal that could not be prepared cannot be applied', async () => {
    const p = proposal({ status: 'failed', result: { error: { code: 'not_found', message: 'old text not found' } } });
    vi.spyOn(api, 'applyProposal').mockRejectedValue(new ApiError(409, 'not_applicable', 'not_applicable: could not be prepared', { proposal: p }));
    render(<ProposalCard proposal={p} />);
    expect(screen.getByTestId('proposal-result').textContent).toContain(`失败：${TOOL_ERROR_LABELS.not_found}`);
    fireEvent.click(screen.getByTestId('proposal-apply'));
    expect((await screen.findByTestId('proposal-error')).textContent).toContain('没能生成，不能写入，请重新提问');
    expect(screen.queryByTestId('proposal-apply')).toBeNull();
    expect(screen.queryByTestId('proposal-diff-toggle')).toBeNull();
  });

  it('the diff is read again after a failed run so a conflict shows the current file', async () => {
    const before = { path: 'app/pay.py', isNew: false, diff: '-a = 1\n+a = 2\n' };
    const after = { path: 'app/pay.py', isNew: false, diff: '-a = 3\n+a = 2\n', changedSinceProposal: true as const };
    const diff = vi.spyOn(api, 'proposalDiff').mockResolvedValueOnce({ files: [before] }).mockResolvedValueOnce({ files: [after] });
    vi.spyOn(api, 'applyProposal').mockRejectedValue(conflictError([{ path: 'app/pay.py', code: 'file_changed_since_proposal', canForce: true }], proposal()));
    render(<ProposalCard proposal={proposal()} />);
    fireEvent.click(screen.getByTestId('proposal-diff-toggle'));
    expect((await screen.findByTestId('diff-body')).textContent).toContain('-a = 1');
    fireEvent.click(screen.getByTestId('proposal-apply'));
    await screen.findByTestId('conflict-file');
    await waitFor(() => expect(screen.getByTestId('diff-body').textContent).toContain('-a = 3'));
    expect(screen.getByTestId('diff-changed')).toBeTruthy();
    expect(diff).toHaveBeenCalledTimes(2);
  });

  it('when a run ends while the diff is loading, the diff is read again and the old one stays visible meanwhile', async () => {
    const first = deferred<{ files: { path: string; isNew: boolean; diff: string }[] }>();
    const second = deferred<{ files: { path: string; isNew: boolean; diff: string }[] }>();
    const diff = vi.spyOn(api, 'proposalDiff').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    vi.spyOn(api, 'applyProposal').mockRejectedValue(new ApiError(409, 'repo_changed', 'repo_changed'));
    render(<ProposalCard proposal={proposal()} />);
    fireEvent.click(screen.getByTestId('proposal-diff-toggle'));
    fireEvent.click(screen.getByTestId('proposal-apply'));
    await screen.findByTestId('proposal-error');
    await act(async () => first.resolve({ files: [{ path: 'app/pay.py', isNew: false, diff: '-old\n' }] }));
    await waitFor(() => expect(diff).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('diff-body').textContent).toContain('-old');
    await act(async () => second.resolve({ files: [{ path: 'app/pay.py', isNew: false, diff: '-new\n' }] }));
    await waitFor(() => expect(screen.getByTestId('diff-body').textContent).toContain('-new'));
  });

  it('a closed diff is read again on the next open after a failed run', async () => {
    const diff = vi.spyOn(api, 'proposalDiff').mockResolvedValue({ files: [{ path: 'app/pay.py', isNew: false, diff: '+a\n' }] });
    vi.spyOn(api, 'applyProposal').mockRejectedValue(new ApiError(409, 'repo_changed', 'repo_changed'));
    render(<ProposalCard proposal={proposal()} />);
    const toggle = () => fireEvent.click(screen.getByTestId('proposal-diff-toggle'));
    toggle();
    await screen.findByTestId('diff-file');
    toggle();
    fireEvent.click(screen.getByTestId('proposal-apply'));
    await screen.findByTestId('proposal-error');
    toggle();
    await waitFor(() => expect(diff).toHaveBeenCalledTimes(2));
    toggle();
    toggle();
    expect(diff).toHaveBeenCalledTimes(2);
  });

  it('a record that could not be built when saved has no actions, no diff and no unread marks', () => {
    const p = proposal({ status: 'failed', unbuilt: true, result: { error: { code: 'not_found', message: 'old text not found' } } });
    render(<ProposalCard proposal={p} />);
    expect(screen.getByTestId('proposal-unbuilt').textContent).toBe('保存时没能生成这条修改，请重新提问');
    expect(screen.queryByTestId('proposal-apply')).toBeNull();
    expect(screen.queryByTestId('proposal-dismiss')).toBeNull();
    expect(screen.queryByTestId('proposal-diff-toggle')).toBeNull();
    expect(screen.queryByTestId('file-unread')).toBeNull();
  });

  it('an error without a new card shows a translated message and keeps the buttons', async () => {
    vi.spyOn(api, 'applyProposal').mockRejectedValue(new ApiError(409, 'repo_changed', 'repo_changed'));
    render(<ProposalCard proposal={proposal()} />);
    fireEvent.click(screen.getByTestId('proposal-apply'));
    expect((await screen.findByTestId('proposal-error')).textContent).toBe('当前仓库已切换，请刷新页面');
    expect(screen.getByTestId('proposal-apply')).toHaveProperty('disabled', false);
  });

  it('a newer card from the session replaces the local result', async () => {
    vi.spyOn(api, 'dismissProposal').mockResolvedValue({ proposal: proposal({ status: 'dismissed', updatedAt: 2 }) });
    const { rerender } = render(<ProposalCard proposal={proposal()} />);
    fireEvent.click(screen.getByTestId('proposal-dismiss'));
    await waitFor(() => expect(card().dataset.status).toBe('dismissed'));
    rerender(<ProposalCard proposal={proposal({ status: 'dismissed', updatedAt: 2 })} />);
    expect(card().dataset.status).toBe('dismissed');
  });
});

function pullRequest(extra: Partial<ProposalView> = {}): ProposalView {
  return {
    id: 5, messageId: 2, kind: 'pull_request', status: 'pending', title: '修复退款', base: 'main', branch: 'codeinsight/fix-refund', source: 'working_tree',
    files: [{ path: 'app/pay.py', isNew: false }, { path: 'app/new.py', isNew: true }, { path: 'app/old.py', isNew: false, deleted: true }],
    unpushedCommits: ['调整退款金额', '补充测试'], createdAt: 1, updatedAt: 1, ...extra,
  };
}

const PR_URL = 'https://github.com/o/r/pull/12';

describe('ProposalCard (pull request)', () => {
  it('pending: title with the branches, files, unpushed commits and the diff', async () => {
    vi.spyOn(api, 'proposalDiff').mockResolvedValue({
      files: [{ path: 'app/old.py', isNew: false, deleted: true, diff: '--- a/app/old.py\n+++ /dev/null\ndeleted file mode 100644\n@@ -1 +0,0 @@\n-x = 1\n' }],
    });
    render(<ProposalCard proposal={pullRequest()} />);
    expect(card().dataset.kind).toBe('pull_request');
    expect(card().querySelector('.proposal-title')!.textContent).toBe('创建 PR：修复退款 → main，新分支 codeinsight/fix-refund');
    expect(screen.getAllByTestId('proposal-file').map((f) => f.textContent)).toEqual(['修改 app/pay.py', '新建 app/new.py', '删除 app/old.py']);
    const unpushed = screen.getByTestId('proposal-unpushed');
    expect(unpushed.textContent).toContain('会一起进 PR');
    expect(within(unpushed).getAllByRole('listitem').map((l) => l.textContent)).toEqual(['调整退款金额', '补充测试']);
    expect(screen.getByTestId('proposal-apply').textContent).toBe('创建 PR');
    fireEvent.click(screen.getByTestId('proposal-diff-toggle'));
    const file = await screen.findByTestId('diff-file');
    expect(file.textContent).toContain('（删除）');
    expect([...screen.getByTestId('diff-body').children].map((l) => l.className)).toEqual(['diff-meta', 'diff-meta', 'diff-meta', 'diff-hunk', 'diff-del']);
  });

  it('shows the body as plain text, folded after a few lines', () => {
    const body = ['## 改动', '修正退款金额', '[文档](https://evil.example)', '<a href="https://x">x</a>', '5', '6', '第七行'].join('\n');
    render(<ProposalCard proposal={pullRequest({ body })} />);
    const text = screen.getByTestId('proposal-body-text');
    expect(text.textContent).toContain('[文档](https://evil.example)');
    expect(text.textContent).toContain('<a href="https://x">x</a>');
    expect(text.textContent).not.toContain('第七行');
    expect(screen.getByTestId('proposal-body').querySelector('a')).toBeNull();
    fireEvent.click(screen.getByTestId('proposal-body-toggle'));
    expect(text.textContent).toBe(body);
    fireEvent.click(screen.getByTestId('proposal-body-toggle'));
    expect(text.textContent).not.toContain('第七行');
  });

  it('a short body has no fold button; no body shows nothing', () => {
    const { unmount } = render(<ProposalCard proposal={pullRequest({ body: '一行说明' })} />);
    expect(screen.getByTestId('proposal-body-text').textContent).toBe('一行说明');
    expect(screen.queryByTestId('proposal-body-toggle')).toBeNull();
    unmount();
    render(<ProposalCard proposal={pullRequest()} />);
    expect(screen.queryByTestId('proposal-body')).toBeNull();
  });

  it('working_tree pull requests explain the temporary git ref until they are applied or dismissed', () => {
    const { rerender } = render(<ProposalCard proposal={pullRequest()} />);
    expect(screen.getByTestId('proposal-ref-note').textContent).toContain('refs/codeinsight/proposals/');
    expect(screen.getByTestId('proposal-ref-note').textContent).toContain('git push --mirror');
    rerender(<ProposalCard proposal={pullRequest({ status: 'applied', updatedAt: 2, result: { url: PR_URL } })} />);
    expect(screen.queryByTestId('proposal-ref-note')).toBeNull();
    rerender(<ProposalCard proposal={pullRequest({ source: 'edits', updatedAt: 3 })} />);
    expect(screen.queryByTestId('proposal-ref-note')).toBeNull();
  });

  it('an unbuilt pull request has no actions and no ref note', () => {
    render(<ProposalCard proposal={pullRequest({ status: 'failed', unbuilt: true, unpushedCommits: undefined, result: { error: { code: 'tree_missing', message: 'x' } } })} />);
    expect(screen.getByTestId('proposal-unbuilt')).toBeTruthy();
    expect(screen.queryByTestId('proposal-apply')).toBeNull();
    expect(screen.queryByTestId('proposal-ref-note')).toBeNull();
  });

  it('edits-based pull requests have no unpushed commit notice', () => {
    render(<ProposalCard proposal={pullRequest({ source: 'edits', unpushedCommits: undefined, files: [{ path: 'a.py', isNew: false, staleSnapshot: false }] })} />);
    expect(screen.queryByTestId('proposal-unpushed')).toBeNull();
  });

  it('creating disables the buttons and then shows the link, which can be copied', async () => {
    const d = deferred<{ proposal: ProposalView }>();
    const apply = vi.spyOn(api, 'applyProposal').mockReturnValue(d.promise);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ProposalCard proposal={pullRequest()} />);
    fireEvent.click(screen.getByTestId('proposal-apply'));
    expect(apply).toHaveBeenCalledWith(5, false);
    expect(screen.getByTestId('proposal-result').textContent).toBe('正在创建 PR…');
    expect(screen.getByTestId('proposal-apply')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('proposal-dismiss')).toHaveProperty('disabled', true);
    await act(async () => d.resolve({ proposal: pullRequest({ status: 'applied', updatedAt: 2, pushed: true, result: { url: PR_URL } }) }));
    const link = screen.getByTestId('proposal-pr-url');
    expect(link.getAttribute('href')).toBe(PR_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(screen.queryByTestId('proposal-unpushed')).toBeNull();
    expect(screen.queryByTestId('proposal-apply')).toBeNull();
    fireEvent.click(screen.getByTestId('proposal-copy'));
    await screen.findByTestId('proposal-copied');
    expect(writeText).toHaveBeenCalledWith(PR_URL);
  });

  it('when the clipboard cannot be written the link text is selected', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }, configurable: true });
    render(<ProposalCard proposal={pullRequest({ status: 'applied', result: { url: PR_URL } })} />);
    fireEvent.click(screen.getByTestId('proposal-copy'));
    expect((await screen.findByTestId('proposal-copy-failed')).textContent).toContain('请手动复制');
    expect(window.getSelection()!.toString()).toBe(PR_URL);
  });

  it('failed after pushing says a retry continues, and retry resends without force', async () => {
    const failed = pullRequest({ status: 'failed', pushed: true, result: { error: { code: 'gh_not_authenticated', message: 'gh is not logged in to github.com' } } });
    const apply = vi.spyOn(api, 'applyProposal').mockResolvedValue({ proposal: pullRequest({ status: 'applied', updatedAt: 2, result: { url: PR_URL } }) });
    render(<ProposalCard proposal={failed} />);
    expect(screen.getByTestId('proposal-result').textContent).toContain('失败：gh 还没有登录，请先运行 gh auth login');
    expect(screen.getByTestId('proposal-pushed').textContent).toBe('分支已推送，重试会继续创建 PR');
    expect(screen.queryByTestId('proposal-force')).toBeNull();
    fireEvent.click(screen.getByTestId('proposal-apply'));
    await waitFor(() => expect(card().dataset.status).toBe('applied'));
    expect(apply).toHaveBeenCalledWith(5, false);
  });

  it('failed before pushing has no pushed note', () => {
    render(<ProposalCard proposal={pullRequest({ status: 'failed', result: { error: { code: 'branch_exists', message: 'x' } } })} />);
    expect(screen.getByTestId('proposal-result').textContent).toContain('远程仓库已有同名分支，且内容不同');
    expect(screen.queryByTestId('proposal-pushed')).toBeNull();
    expect(screen.getByTestId('proposal-apply').textContent).toBe('重试');
  });

  it('dismiss marks the pull request as ignored', async () => {
    vi.spyOn(api, 'dismissProposal').mockResolvedValue({ proposal: pullRequest({ status: 'dismissed', updatedAt: 2 }) });
    render(<ProposalCard proposal={pullRequest()} />);
    fireEvent.click(screen.getByTestId('proposal-dismiss'));
    await waitFor(() => expect(screen.getByTestId('proposal-result').textContent).toBe('已忽略'));
    expect(screen.queryByTestId('proposal-unpushed')).toBeNull();
  });

  it('every pull request error code has a Chinese explanation', () => {
    const codes = [
      'origin_missing', 'origin_unknown', 'push_target_mismatch', 'push_target_unknown', 'gh_missing', 'gh_not_authenticated', 'gh_failed',
      'pr_create_failed', 'invalid_proposal', 'tree_missing', 'branch_exists', 'lfs_not_supported', 'nested_repository', 'no_changes',
      'fetch_failed', 'git_failed', 'cancelled', 'not_supported',
    ];
    for (const code of codes) expect(proposalErrorText(code), code).toMatch(/[\u4e00-\u9fff]/);
    expect(proposalErrorText('lfs_not_supported', 'a.bin is stored with Git LFS')).toBe('有文件用 Git LFS 存储，暂不支持，请手动创建 PR（a.bin is stored with Git LFS）');
  });
});

function chatWith(detail: ChatSessionDetail, status = makeStatus()) {
  localStorage.setItem(NOTICE_KEY, JSON.stringify({ provider: 'anthropic', model: 'claude-x', sendSource: true }));
  vi.spyOn(api, 'chatSessions').mockResolvedValue({ sessions: [{ id: 1, title: '退款', createdAt: 1, updatedAt: 1 }] });
  vi.spyOn(api, 'chatSession').mockResolvedValue(detail);
  return render(<NavContext.Provider value={makeNav()}><ChatPage status={status} /></NavContext.Provider>);
}

describe('ChatPage with proposals', () => {
  const detail: ChatSessionDetail = {
    id: 1, title: '退款', createdAt: 1, updatedAt: 1, answering: false,
    messages: [
      { id: 1, sessionId: 1, role: 'user', content: '改一下', meta: null, createdAt: 1 },
      {
        id: 2, sessionId: 1, role: 'assistant', content: '已生成修改', createdAt: 1, proposals: [proposal()],
        meta: { status: 'done', contentKey: 'ck1', sendSource: true, refs: {}, toolCalls: [{ name: 'propose_file_changes', args: { summary: '修正', files: [{ path: 'app/pay.py' }] }, resultChars: 10, ms: 1 }] },
      },
    ],
  };

  it('saved answers show their cards and the write scope note above the input', async () => {
    chatWith(detail, makeStatus({ writeScope: { repo: true, dirs: ['notes'] } }));
    const answer = await screen.findByTestId('chat-answer');
    expect(within(answer).getByTestId('proposal-card').dataset.status).toBe('pending');
    expect(within(answer).getByTestId('tool-steps').querySelector('summary')!.textContent).toBe('生成了 1 个待确认修改');
    expect(screen.getByTestId('write-scope').textContent).toContain('可写：当前仓库、notes（仅新建）');
    expect(screen.getByTestId('write-scope').textContent).toContain('确认后才会写入');
  });

  it('the write scope note is hidden without a repository', async () => {
    chatWith(detail, makeStatus({ repo: null, writeScope: { repo: false, dirs: [] } }));
    await screen.findByTestId('chat-answer');
    expect(screen.queryByTestId('write-scope')).toBeNull();
  });
});
