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
