import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api/client';
import { SourcePanel } from '../src/source/SourcePanel';
import { info, tree } from './fixtures';

describe('SourcePanel', () => {
  it('shows the whole function with clickable calls that navigate to the callee', async () => {
    const g = info('g', { startLine: 9, endLine: 10 });
    vi.spyOn(api, 'symbol').mockResolvedValue({ snapshotId: 1, resolverStatus: 'ok', symbol: { ...g, docstring: null, parent: null }, entries: [], callers: { total: 0, prod: 0, test: 0 }, callees: { total: 1, prod: 1, test: 0 } });
    vi.spyOn(api, 'source').mockResolvedValue({ snapshotId: 1, path: 'pkg/a.py', start: 9, end: 10, totalLines: 20, content: 'def g():\n    return f(1)' });
    vi.spyOn(api, 'callees').mockResolvedValue(tree(g, 'callees', [info('f')], [{ srcId: g.id, dstId: 'id-f', kind: 'call', path: 'pkg/a.py', line: 10, col: 11 }]));
    const onNavigate = vi.fn();
    render(<SourcePanel target={{ snapshotId: 1, symbolId: g.id }} onNavigate={onNavigate} onClose={vi.fn()} onGone={vi.fn()} />);
    const call = await screen.findByTestId('source-call');
    expect(call.textContent).toBe('f');
    expect(screen.getByTestId('source-code').textContent).toContain('def g():');
    expect(api.source).toHaveBeenCalledWith(1, 'pkg/a.py', 9, 10);
    fireEvent.click(call);
    expect(onNavigate).toHaveBeenCalledWith(1, expect.objectContaining({ id: 'id-f' }));
  });

  it('explains file_changed instead of showing the raw error code', async () => {
    const g = info('g', { startLine: 9, endLine: 10 });
    vi.spyOn(api, 'symbol').mockResolvedValue({ snapshotId: 1, resolverStatus: 'ok', symbol: { ...g, docstring: null, parent: null }, entries: [], callers: { total: 0, prod: 0, test: 0 }, callees: { total: 1, prod: 1, test: 0 } });
    vi.spyOn(api, 'source').mockRejectedValue(new ApiError(409, 'file_changed', 'file_changed'));
    vi.spyOn(api, 'callees').mockResolvedValue(tree(g, 'callees', [], []));
    render(<SourcePanel target={{ snapshotId: 1, symbolId: g.id }} onNavigate={vi.fn()} onClose={vi.fn()} onGone={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('读取源码失败：文件在建索引后已修改，请重新建索引')).toBeTruthy());
  });

  it('opens a whole file by path and highlights the target lines', async () => {
    const source = vi.spyOn(api, 'source').mockResolvedValue({ snapshotId: 1, path: 'pkg/a.py', start: 1, end: 4, totalLines: 4, content: 'a\nb\nc\nd' });
    const symbol = vi.spyOn(api, 'symbol');
    render(<SourcePanel target={{ snapshotId: 1, path: 'pkg/a.py', start: 2, end: 3 }} onNavigate={vi.fn()} onClose={vi.fn()} onGone={vi.fn()} />);
    const code = await screen.findByTestId('source-code');
    expect(source).toHaveBeenCalledWith(1, 'pkg/a.py', 1, 203);
    expect(symbol).not.toHaveBeenCalled();
    expect(screen.queryByTestId('source-excerpt')).toBeNull();
    expect([...code.querySelectorAll('[data-highlight]')].map((l) => l.getAttribute('data-line'))).toEqual(['2', '3']);
    expect(screen.getByRole('heading').textContent).toBe('pkg/a.py:2');
  });

  it('by path reads only the lines around the target and says so', async () => {
    const content = Array.from({ length: 401 }, (_, i) => `line ${i + 300}`).join('\n');
    const source = vi.spyOn(api, 'source').mockResolvedValue({ snapshotId: 1, path: 'big.py', start: 300, end: 700, totalLines: 5000, content });
    render(<SourcePanel target={{ snapshotId: 1, path: 'big.py', start: 500 }} onNavigate={vi.fn()} onClose={vi.fn()} onGone={vi.fn()} />);
    expect((await screen.findByTestId('source-excerpt')).textContent).toBe('只显示目标行附近的片段：第 300–700 行（文件共 5000 行）');
    expect(source).toHaveBeenCalledWith(1, 'big.py', 300, 700);
    expect(screen.getByTestId('source-code').querySelector('[data-highlight]')!.textContent).toContain('line 500');
  });

  it('a target line past the end of the file shows the end of the file without highlight or error', async () => {
    const content = Array.from({ length: 21 }, (_, i) => `line ${i + 80}`).join('\n');
    const source = vi.spyOn(api, 'source').mockResolvedValue({ snapshotId: 1, path: 'short.py', start: 80, end: 100, totalLines: 100, content });
    render(<SourcePanel target={{ snapshotId: 1, path: 'short.py', start: 500, end: 510 }} onNavigate={vi.fn()} onClose={vi.fn()} onGone={vi.fn()} />);
    expect((await screen.findByTestId('source-excerpt')).textContent).toBe('目标行（第 500 行）超出文件范围（文件共 100 行），显示文件末尾第 80–100 行');
    expect(source).toHaveBeenCalledWith(1, 'short.py', 300, 710);
    expect(screen.getByTestId('source-code').querySelector('[data-highlight]')).toBeNull();
    expect(screen.queryByText(/读取源码失败/)).toBeNull();
  });

  it('shows a visible error and reports snapshot_gone', async () => {
    vi.spyOn(api, 'symbol').mockRejectedValue(new ApiError(410, 'snapshot_gone', 'snapshot_gone'));
    const onGone = vi.fn();
    render(<SourcePanel target={{ snapshotId: 7, symbolId: 'x' }} onNavigate={vi.fn()} onClose={vi.fn()} onGone={onGone} />);
    await waitFor(() => expect(screen.getByText(/读取源码失败：snapshot_gone/)).toBeTruthy());
    expect(onGone).toHaveBeenCalledTimes(1);
  });
});
