import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api/client';
import { useNavigation } from '../src/app/useNavigation';
import { useSnapshotProbe } from '../src/review/useSnapshotProbe';
import { change, makeReport } from './fixtures';

const gone = () => new ApiError(410, 'snapshot_gone', 'snapshot_gone');
const loc = { snapshotId: 1, id: 'x', name: 'x', path: 'pkg/a.py', line: 1 };

describe('useNavigation snapshotGone', () => {
  it('source opened from the review tab: stays on review and shows the report notice, no entry-list banner', () => {
    const { result } = renderHook(() => useNavigation(vi.fn()));
    act(() => result.current.switchTab('review'));
    act(() => result.current.nav.showSource(loc));
    act(() => result.current.nav.snapshotGone());
    expect(result.current.tab).toBe('review');
    expect(result.current.reviewGone).toBe(true);
    expect(result.current.banner).toBeUndefined();
    expect(result.current.source).toBeUndefined();
  });

  it('in the browse view: goes back to the entry list and says so', () => {
    const refresh = vi.fn();
    const { result } = renderHook(() => useNavigation(refresh));
    act(() => result.current.nav.openGraph(loc, 'browse'));
    act(() => result.current.nav.snapshotGone());
    expect(result.current.tab).toBe('browse');
    expect(result.current.trail).toEqual([]);
    expect(result.current.banner).toContain('已回到入口列表');
    expect(refresh).toHaveBeenCalled();
  });
});

describe('useSnapshotProbe', () => {
  it('checks both snapshots and reports gone when only the base side was cleaned up', async () => {
    const symbol = vi.spyOn(api, 'symbol').mockImplementation(async (snap) => {
      if (snap === 1) throw gone();
      return {} as never;
    });
    const report = makeReport();
    const { result } = renderHook(() => useSnapshotProbe(report));
    await waitFor(() => expect(result.current).toBe(true));
    expect(symbol.mock.calls).toEqual([[1, 'id-old_fn'], [2, 'id-new_fn']]);
  });

  it('stays false when both snapshots exist, and skips a side without a snapshot', async () => {
    const symbol = vi.spyOn(api, 'symbol').mockResolvedValue({} as never);
    const report = makeReport({ base: { ref: 'x', sha: 'b'.repeat(40), snapshotId: null }, modules: [{ module: 'pkg', symbols: [change('a', 'added')] }] });
    const { result } = renderHook(() => useSnapshotProbe(report));
    await waitFor(() => expect(symbol).toHaveBeenCalledTimes(1));
    expect(symbol).toHaveBeenCalledWith(2, 'id-a');
    expect(result.current).toBe(false);
  });
});
