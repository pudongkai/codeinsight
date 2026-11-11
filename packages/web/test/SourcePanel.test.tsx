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

  it('shows a visible error and reports snapshot_gone', async () => {
    vi.spyOn(api, 'symbol').mockRejectedValue(new ApiError(410, 'snapshot_gone', 'snapshot_gone'));
    const onGone = vi.fn();
    render(<SourcePanel target={{ snapshotId: 7, symbolId: 'x' }} onNavigate={vi.fn()} onClose={vi.fn()} onGone={onGone} />);
    await waitFor(() => expect(screen.getByText(/读取源码失败：snapshot_gone/)).toBeTruthy());
    expect(onGone).toHaveBeenCalledTimes(1);
  });
});
