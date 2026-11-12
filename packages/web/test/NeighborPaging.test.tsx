import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import type { SymbolInfo } from '../src/api/types';
import { NavContext, type Nav } from '../src/app/nav';
import { BrowseView } from '../src/browse/BrowseView';
import type { Crumb } from '../src/browse/Breadcrumbs';
import type { GraphNodeSpec } from '../src/graph/types';
import { info, tree } from './fixtures';

// React Flow 和 ELK 需要真实布局；这里只看传给图的节点（名字、页码），布局在 Playwright 测试里覆盖
vi.mock('../src/graph/FlowGraph', () => ({
  FlowGraph: ({ nodes, testId }: { nodes: GraphNodeSpec[]; testId?: string }) => (
    <div data-testid={testId}>
      {nodes.map((n) => (
        <div key={n.id} data-testid="stub-node" data-side={n.attrs?.side} data-name={n.label}>
          {n.onExpand && <button type="button" data-testid="stub-expand" onClick={n.onExpand} />}
          {n.pager && <button type="button" data-testid="stub-node-next" onClick={() => n.pager!.onPage(n.pager!.page + 1)}>{`${n.pager.page + 1}/${n.pager.pages}`}</button>}
        </div>
      ))}
    </div>
  ),
}));

const nav: Nav = { openSymbol: vi.fn(), showSource: vi.fn(), openSourceAt: vi.fn(), openGraph: vi.fn(), snapshotGone: vi.fn(), indexNotReady: vi.fn() };
const pad = (i: number) => String(i).padStart(2, '0');
const callersOf: Record<string, SymbolInfo[]> = {
  center: Array.from({ length: 12 }, (_, i) => info(`c${pad(i + 1)}`)),
  other: [info('o1'), info('Model1', { kind: 'class', modelKind: 'pydantic' })],
  model: [info('u1'), info('M1', { kind: 'class', modelKind: 'pydantic' }), info('M2', { kind: 'class', modelKind: 'django' })],
};
const centers: Record<string, SymbolInfo> = { center: info('center'), other: info('other'), model: info('model', { kind: 'class', modelKind: 'pydantic' }) };

function mockApi() {
  vi.spyOn(api, 'callers').mockImplementation(async (_s, id) => tree(centers[id.slice(3)]!, 'callers', callersOf[id.slice(3)] ?? []));
  vi.spyOn(api, 'callees').mockImplementation(async (_s, id) => tree(centers[id.slice(3)]!, 'callees', id === 'id-center' ? [info('d1'), info('d2'), info('d3')] : []));
  vi.spyOn(api, 'symbol').mockImplementation(async (_s, id) => ({
    snapshotId: 1, resolverStatus: 'ok', symbol: { ...centers[id.slice(3)]!, docstring: null, parent: null }, entries: [],
    callers: { total: 0, prod: 0, test: 0 }, callees: { total: 0, prod: 0, test: 0 },
  }));
}

function view(trail: Crumb[]) {
  return (
    <NavContext.Provider value={nav}>
      <BrowseView currentSnapshotId={1} trail={trail} onHome={vi.fn()} onPickCrumb={vi.fn()} />
    </NavContext.Provider>
  );
}

const crumb = (name: string): Crumb => ({ snapshotId: 1, id: `id-${name}`, name });
const callerNames = () => screen.queryAllByTestId('stub-node').filter((n) => n.dataset.side === 'caller').map((n) => n.dataset.name);
const callerPager = () => screen.getByTestId('pager-caller');

afterEach(() => window.localStorage.clear());

describe('neighbor graph paging', () => {
  it('shows 5 callers per page, pages forward, and starts from page 1 for a new center', async () => {
    mockApi();
    const { rerender } = render(view([crumb('center')]));
    await waitFor(() => expect(callerNames()).toEqual(['c01', 'c02', 'c03', 'c04', 'c05']));
    expect(within(callerPager()).getByTestId('pager-text').textContent).toBe('第 1 / 3 页，共 12 个');
    expect(within(screen.getByTestId('pager-callee')).getByTestId('pager-text').textContent).toBe('共 3 个');
    expect(screen.getByTestId('pager-callee').querySelector('[data-testid=pager-next]')).toBeNull();
    fireEvent.click(within(callerPager()).getByTestId('pager-next'));
    expect(callerNames()).toEqual(['c06', 'c07', 'c08', 'c09', 'c10']);
    expect(within(callerPager()).getByTestId('pager-text').textContent).toBe('第 2 / 3 页，共 12 个');
    fireEvent.click(within(callerPager()).getByTestId('pager-next'));
    expect(callerNames()).toEqual(['c11', 'c12']);
    expect((within(callerPager()).getByTestId('pager-next') as HTMLButtonElement).disabled).toBe(true);

    rerender(view([crumb('center'), crumb('other')]));
    await waitFor(() => expect(callerNames()).toEqual(['o1', 'Model1']));
    rerender(view([crumb('center'), crumb('other'), crumb('center')]));
    await waitFor(() => expect(callerNames()).toEqual(['c01', 'c02', 'c03', 'c04', 'c05']));
    expect(callerPager().dataset.page).toBe('1');
  });

  it('pages the next level of an expanded node inside the node', async () => {
    mockApi();
    vi.mocked(api.callers).mockImplementation(async (_s, id) =>
      id === 'id-center' ? tree(centers.center!, 'callers', [info('c01')]) : tree(info('c01'), 'callers', Array.from({ length: 7 }, (_, i) => info(`x${i}`))),
    );
    render(view([crumb('center')]));
    await waitFor(() => expect(callerNames()).toEqual(['c01']));
    fireEvent.click(within(screen.getAllByTestId('stub-node').find((n) => n.dataset.name === 'c01')!).getByTestId('stub-expand'));
    await waitFor(() => expect(callerNames()).toEqual(['c01', 'x0', 'x1', 'x2', 'x3', 'x4']));
    const next = screen.getByTestId('stub-node-next');
    expect(next.textContent).toBe('1/2');
    fireEvent.click(next);
    expect(callerNames()).toEqual(['c01', 'x5', 'x6']);
  });
});

describe('show models toggle', () => {
  it('hides model nodes, recounts the page and says how many were hidden; the choice survives a reload', async () => {
    mockApi();
    const { unmount } = render(view([crumb('other')]));
    await waitFor(() => expect(callerNames()).toEqual(['o1', 'Model1']));
    const toggle = screen.getByTestId('toggle-models') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(callerNames()).toEqual(['o1']);
    expect(within(callerPager()).getByTestId('pager-text').textContent).toBe('共 1 个');
    expect(within(callerPager()).getByTestId('pager-hidden-models').textContent).toBe('已隐藏 1 个模型');
    expect(window.localStorage.getItem('codeinsight.graph.showModels')).toBe('false');
    unmount();

    render(view([crumb('other')]));
    await waitFor(() => expect(callerNames()).toEqual(['o1']));
    expect((screen.getByTestId('toggle-models') as HTMLInputElement).checked).toBe(false);
  });

  it('keeps a model center visible', async () => {
    mockApi();
    window.localStorage.setItem('codeinsight.graph.showModels', 'false');
    render(view([crumb('model')]));
    await waitFor(() => expect(callerNames()).toEqual(['u1']));
    expect(screen.getAllByTestId('stub-node').find((n) => n.dataset.side === 'center')?.dataset.name).toBe('model');
    expect(within(callerPager()).getByTestId('pager-hidden-models').textContent).toBe('已隐藏 2 个模型');
  });

  it('falls back to showing models when localStorage is unavailable', async () => {
    mockApi();
    const storage = Object.getPrototypeOf(window.localStorage) as Storage;
    vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    render(view([crumb('other')]));
    await waitFor(() => expect(callerNames()).toEqual(['o1', 'Model1']));
    fireEvent.click(screen.getByTestId('toggle-models'));
    expect(callerNames()).toEqual(['o1']);
  });
});
