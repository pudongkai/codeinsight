import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { NavContext, type Nav } from '../src/app/nav';
import { EntryList } from '../src/browse/EntryList';
import { SearchBox } from '../src/browse/SearchBox';
import { SymbolDetail } from '../src/browse/SymbolDetail';
import { SymbolNode, type SymbolFlowNode } from '../src/graph/SymbolNode';
import { symbolMarks } from '../src/marks/marks';
import { ChangeList } from '../src/report/ChangeList';
import { change, info } from './fixtures';

const nav: Nav = { openSymbol: vi.fn(), showSource: vi.fn(), openSourceAt: vi.fn(), openGraph: vi.fn(), snapshotGone: vi.fn(), indexNotReady: vi.fn() };
const http = { kind: 'http', framework: 'fastapi', detail: { method: 'GET', path: '/users/{id}' } };

function marksIn(el: Element): string[] {
  return [...el.querySelectorAll('[data-testid=symbol-mark]')].map((m) => m.textContent ?? '');
}

describe('symbol marks', () => {
  it('derives 接口 / 模型 / 方法 marks; middleware and plain functions get none', () => {
    expect(symbolMarks({ kind: 'function', entry: http })).toEqual([{ kind: 'api', label: '接口', title: 'HTTP 接口（fastapi） GET /users/{id}' }]);
    expect(symbolMarks({ kind: 'class', modelKind: 'sqlalchemy' }).map((m) => m.title)).toEqual(['数据模型（SQLAlchemy）']);
    expect(symbolMarks({ kind: 'method', entry: http }).map((m) => m.label)).toEqual(['接口', '方法']);
    expect(symbolMarks({ kind: 'function', entry: { kind: 'http', framework: 'fastapi', detail: { middleware: 'http' } } })).toEqual([]);
    expect(symbolMarks({ kind: 'function' })).toEqual([]);
  });

  it('shows marks on graph nodes and puts the route into the tooltip', () => {
    const spec = { id: 'n', label: 'get_user', title: 'get_user', tone: 'neighbor' as const, marks: symbolMarks({ kind: 'function', entry: http }) };
    const props = { id: 'n', data: { spec } } as unknown as Parameters<typeof SymbolNode>[0] & { data: SymbolFlowNode['data'] };
    render(<ReactFlowProvider><SymbolNode {...props} /></ReactFlowProvider>);
    const node = screen.getByTestId('graph-node');
    expect(marksIn(node)).toEqual(['接口']);
    expect(node.getAttribute('title')).toContain('GET /users/{id}');
  });

  it('shows marks in search results, the entry list and the symbol detail', async () => {
    vi.spyOn(api, 'search').mockResolvedValue({ snapshotId: 1, results: [info('User', { kind: 'class', modelKind: 'pydantic' }), info('save', { kind: 'method' })] });
    vi.spyOn(api, 'entries').mockResolvedValue({ snapshotId: 1, entries: [{ ...http, symbol: info('get_user') }] });
    vi.spyOn(api, 'symbol').mockResolvedValue({
      snapshotId: 1, resolverStatus: 'ok', symbol: { ...info('get_user', { entry: http }), docstring: null, parent: null },
      entries: [http], callers: { total: 0, prod: 0, test: 0 }, callees: { total: 0, prod: 0, test: 0 },
    });
    render(
      <NavContext.Provider value={nav}>
        <SearchBox ready />
        <EntryList snapshotId={1} />
        <SymbolDetail snapshotId={1} id="id-get_user" />
      </NavContext.Provider>,
    );
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'u' } });
    await waitFor(() => expect(screen.getAllByTestId('search-result')).toHaveLength(2));
    const results = screen.getAllByTestId('search-result').map((b) => marksIn(b.parentElement!));
    expect(results).toEqual([['模型'], ['方法']]);
    await waitFor(() => expect(marksIn(screen.getByTestId('entry-list'))).toEqual(['接口']));
    await waitFor(() => expect(marksIn(screen.getByTestId('symbol-detail'))).toEqual(['接口']));
  });

  it('shows marks in the change list of a report', () => {
    const modules = [{ module: 'pkg', symbols: [change('Item', 'added', { kind: 'class', modelKind: 'pydantic' }), change('Svc.run', 'modified', { kind: 'method' }), change('get_user', 'added', { entry: http })] }];
    render(<ChangeList modules={modules} onSelect={vi.fn()} />);
    expect(screen.getAllByTestId('change-row').map(marksIn)).toEqual([['模型'], ['方法'], ['接口']]);
  });
});
