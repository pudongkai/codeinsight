import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { StatusResponse } from '../src/api/types';
import { StatusBar } from '../src/app/StatusBar';
import { makeStatus } from './fixtures';

const SHA = 'abc1234def'.padEnd(40, '0');
const AT = new Date(2026, 10, 13, 10, 2, 30).getTime();

function status(extra: { dirty?: boolean; cached?: boolean; changes?: Partial<StatusResponse['changes']>; running?: boolean } = {}): StatusResponse {
  const base = makeStatus();
  return {
    ...base,
    snapshot: { ...base.snapshot!, id: 7, commitSha: SHA, createdAt: AT, dirty: extra.dirty ?? false },
    index: {
      job: { id: 3, reason: 'startup', status: extra.running ? 'running' : 'done', snapshotId: 7, cached: extra.cached ?? false, startedAt: AT },
      lastDoneAt: AT,
    },
    changes: { checkedAt: AT, codeChanged: false, autoReindex: false, autoReindexFailed: false, ...extra.changes },
  };
}

function renderBar(s: StatusResponse) {
  const onReindex = vi.fn();
  render(<StatusBar status={s} onReindex={onReindex} onRepoSwitched={() => undefined} />);
  return onReindex;
}

describe('StatusBar index source', () => {
  it('shows the index time and commit; no uncommitted note, reuse note or change notice by default', () => {
    renderBar(status());
    expect(screen.getByTestId('index-time').textContent).toBe('索引建于 11-13 10:02');
    expect(screen.getByTestId('index-commit').textContent).toBe('基于 abc1234d');
    expect(screen.queryByTestId('index-reused')).toBeNull();
    expect(screen.queryByTestId('code-changed')).toBeNull();
  });

  it('notes uncommitted changes in the indexed code', () => {
    renderBar(status({ dirty: true }));
    expect(screen.getByTestId('index-commit').textContent).toBe('基于 abc1234d（含未提交改动）');
  });

  it('notes when the last index job reused an existing index', () => {
    renderBar(status({ cached: true }));
    expect(screen.getByTestId('index-reused').textContent).toBe('复用已有索引');
  });

  it('when the code changed offers "更新索引", or says it will update automatically', () => {
    const onReindex = renderBar(status({ changes: { codeChanged: true } }));
    expect(screen.getByTestId('code-changed').textContent).toContain('代码已变化，索引不是最新的');
    fireEvent.click(screen.getByTestId('update-index'));
    expect(onReindex).toHaveBeenCalledTimes(1);
  });

  it('with auto reindex on says the index will be updated later; nothing while an index job is running', () => {
    renderBar(status({ changes: { codeChanged: true, autoReindex: true } }));
    expect(screen.getByTestId('code-changed').textContent).toBe('代码已变化，稍后自动更新索引');
    expect(screen.queryByTestId('update-index')).toBeNull();
  });

  it('after the automatic update failed says so and offers "更新索引"', () => {
    const onReindex = renderBar(status({ changes: { codeChanged: true, autoReindex: true, autoReindexFailed: true } }));
    expect(screen.getByTestId('code-changed').textContent).toContain('自动更新索引失败');
    fireEvent.click(screen.getByTestId('update-index'));
    expect(onReindex).toHaveBeenCalledTimes(1);
  });

  it('hides the change notice while the index is being rebuilt', () => {
    renderBar(status({ changes: { codeChanged: true }, running: true }));
    expect(screen.queryByTestId('code-changed')).toBeNull();
  });
});

describe('StatusBar resolver warning', () => {
  it('names the failed languages when only some languages failed, and keeps the general warning otherwise', () => {
    const base = status();
    const partial = { ...base, snapshot: { ...base.snapshot!, resolverStatus: 'failed', failedLanguages: ['python'] } };
    const { unmount } = render(<StatusBar status={partial} onReindex={() => undefined} onRepoSwitched={() => undefined} />);
    expect(screen.getByTestId('resolver-warning').textContent).toBe('Python 调用关系解析失败，这部分的邻居图不可用');
    unmount();
    renderBar({ ...base, snapshot: { ...base.snapshot!, resolverStatus: 'failed' } });
    expect(screen.getByTestId('resolver-warning').textContent).toBe('调用关系解析失败，邻居图不可用');
  });

  it('says Go call edges come from name matching, with the install command when scip-go was not found', () => {
    const base = status();
    const withGo = (go: { source: 'name_match'; reason: 'not_found' | 'failed' | 'disabled' | 'no_module'; note?: string }) => (
      { ...base, snapshot: { ...base.snapshot!, edgeSources: { python: { source: 'scip' as const }, go } } });
    const { unmount } = render(<StatusBar status={withGo({ source: 'name_match', reason: 'not_found' })} onReindex={() => undefined} onRepoSwitched={() => undefined} />);
    expect(screen.getByTestId('name-match-hint').textContent).toContain('Go 调用关系来自名称匹配（未找到 scip-go），可能不完整');
    expect(screen.getByTestId('scip-go-install').textContent).toBe('go install github.com/scip-code/scip-go/cmd/scip-go@latest');
    unmount();
    const second = render(<StatusBar status={withGo({ source: 'name_match', reason: 'failed', note: 'go list: boom' })} onReindex={() => undefined} onRepoSwitched={() => undefined} />);
    expect(screen.getByTestId('name-match-hint').textContent).toBe('Go 调用关系来自名称匹配（scip-go 运行失败），可能不完整');
    expect(screen.getByTestId('name-match-hint').getAttribute('title')).toBe('go list: boom');
    expect(screen.queryByTestId('scip-go-install')).toBeNull();
    second.unmount();
    const third = render(<StatusBar status={withGo({ source: 'name_match', reason: 'no_module' })} onReindex={() => undefined} onRepoSwitched={() => undefined} />);
    expect(screen.getByTestId('name-match-hint').textContent).toBe('Go 调用关系来自名称匹配（项目没有 go.mod），可能不完整');
    expect(screen.queryByTestId('scip-go-install')).toBeNull();
    third.unmount();
    renderBar(withGo({ source: 'name_match', reason: 'disabled' }));
    expect(screen.queryByTestId('name-match-hint')).toBeNull();
  });

  it('shows no warning when resolution succeeded', () => {
    renderBar(status());
    expect(screen.queryByTestId('resolver-warning')).toBeNull();
  });
});
