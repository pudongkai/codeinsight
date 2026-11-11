import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import type { TreeResponse } from '../src/api/types';
import { useNeighborGraph } from '../src/browse/useNeighborGraph';
import { info, tree } from './fixtures';

describe('useNeighborGraph', () => {
  it('ignores a second "expand" on a node whose request is still running', async () => {
    const center = info('center');
    let finish: (t: TreeResponse) => void = () => undefined;
    const callers = vi.spyOn(api, 'callers').mockImplementation(async (_s, id) =>
      id === center.id ? tree(center, 'callers', [info('a')]) : new Promise<TreeResponse>((r) => (finish = r)),
    );
    vi.spyOn(api, 'callees').mockResolvedValue(tree(center, 'callees', []));
    const { result } = renderHook(() => useNeighborGraph(1, center.id, vi.fn()));
    await waitFor(() => expect(result.current.state).toBeDefined());
    let first!: Promise<void>;
    act(() => {
      first = result.current.expand('id-a');
    });
    await act(() => result.current.expand('id-a'));
    expect(callers).toHaveBeenCalledTimes(2);
    expect(result.current.loading).toBe('id-a');
    await act(async () => {
      finish(tree(info('a'), 'callers', [info('b')]));
      await first;
    });
    expect(result.current.loading).toBeUndefined();
    expect(result.current.state?.nodes['id-b']).toMatchObject({ side: 'caller', level: 2 });
    expect(result.current.state?.nodes['id-a']?.expanded).toBe(true);
  });
});
