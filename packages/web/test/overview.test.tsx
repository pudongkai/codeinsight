import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api/client';
import type { OverviewResponse, StatusResponse } from '../src/api/types';
import { NavContext, type Nav } from '../src/app/nav';
import { useNavigation } from '../src/app/useNavigation';
import { BrowseView } from '../src/browse/BrowseView';
import type { GraphEdgeSpec, GraphNodeSpec } from '../src/graph/types';
import { buildModuleGraph, edgeWidth, MAX_GRAPH_MODULES } from '../src/overview/module-graph';
import { OverviewPage } from '../src/overview/OverviewPage';
import { useOverviewJob } from '../src/overview/useOverviewJob';
import { info, makeNav as nav, makeOverview, makeStatus as status, overviewModule, tree } from './fixtures';

// 只看传给图的节点和边（颜色、粗细）；布局和点击在 Playwright 测试里覆盖
vi.mock('../src/graph/FlowGraph', () => ({
  FlowGraph: ({ nodes, edges, testId, onNodeClick }: { nodes: GraphNodeSpec[]; edges: GraphEdgeSpec[]; testId?: string; onNodeClick?: (id: string) => void }) => (
    <div data-testid={testId}>
      {nodes.map((n) => <button type="button" key={n.id} data-testid="stub-node" data-id={n.id} data-level={n.attrs?.level} data-side={n.attrs?.side} onClick={() => onNodeClick?.(n.id)}>{n.label}</button>)}
      {edges.map((e) => <div key={e.id} data-testid="stub-edge" data-id={e.id} data-tone={e.tone} />)}
    </div>
  ),
}));

function response(extra: Partial<OverviewResponse> = {}): OverviewResponse {
  return { id: 1, overview: makeOverview(), stale: false, currentContentKey: 'ck1', ...extra };
}

function renderPage(n: Nav = nav(), s: StatusResponse = status()) {
  render(<NavContext.Provider value={n}><OverviewPage status={s} refreshStatus={vi.fn()} /></NavContext.Provider>);
  return n;
}

describe('module graph', () => {
  it('cycle edges are red, cross-layer edges orange, others normal; width grows with weight', () => {
    const g = buildModuleGraph(makeOverview(), { showAll: false });
    expect(g.nodes.map((n) => n.id)).toEqual(['app/orders', 'app/payments', 'app/users']);
    expect(Object.fromEntries(g.edges.map((e) => [e.id, e.tone]))).toEqual({
      'app/orders->app/payments': 'cycle', 'app/payments->app/orders': 'cycle', 'app/users->app/orders': 'layer',
    });
    expect(edgeWidth(0)).toBe(1);
    expect(edgeWidth(3)).toBeGreaterThan(edgeWidth(1));
    expect(edgeWidth(10_000)).toBe(6);
  });

  it('nodes show name, id, size, issue count and external categories', () => {
    const g = buildModuleGraph(makeOverview(), { showAll: false, selected: 'app/payments' });
    const pay = g.nodes.find((n) => n.id === 'app/payments')!;
    expect(pay).toMatchObject({ label: '支付', sublabel: 'app/payments · 规模 10', tone: 'center', badge: '1 问题' });
    expect(pay.tags).toEqual([{ label: '支付', title: '支付：stripe' }]);
    expect(g.nodes.find((n) => n.id === 'app/users')!.tone).toBe('neighbor');
  });

  it(`with more than ${MAX_GRAPH_MODULES} modules shows only modules with issues and the heaviest edges unless showAll`, () => {
    const modules = Array.from({ length: MAX_GRAPH_MODULES + 5 }, (_, i) => overviewModule(`m${i}`));
    const report = makeOverview({ modules, moduleEdges: [{ from: 'm1', to: 'm2', weight: 5, kinds: ['call'], samples: [], inCycle: false }], issues: [{ kind: 'private_access', severity: 'info', modules: ['m3', 'm4'], message: 'x', samples: [] }] });
    const g = buildModuleGraph(report, { showAll: false });
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(g.hiddenModules).toBe(modules.length - 4);
    expect(buildModuleGraph(report, { showAll: true }).nodes).toHaveLength(modules.length);
  });
});

describe('OverviewPage', () => {
  it('renders the system card, module list with distinct AI states, and the colored graph', async () => {
    vi.spyOn(api, 'overview').mockResolvedValue(response());
    renderPage();
    expect((await screen.findByTestId('system-title')).textContent).toBe('商城系统');
    const states = screen.getAllByTestId('module-item').map((li) => within(li).getByTestId('ai-status'));
    expect(states.map((s) => [s.dataset.status, s.textContent])).toEqual([['ok', 'AI'], ['failed', 'AI 失败'], ['cached', 'AI·缓存']]);
    expect(screen.getAllByTestId('stub-edge').map((e) => e.dataset.tone)).toEqual(['cycle', 'cycle', 'layer']);
    expect(api.overview).toHaveBeenCalledWith(undefined);
  });

  it('clicking a module shows its responsibility, external dependencies and env vars', async () => {
    vi.spyOn(api, 'overview').mockResolvedValue(response());
    renderPage();
    fireEvent.click(await screen.findByText('支付', { selector: '[data-testid=stub-node]' }));
    const detail = screen.getByTestId('module-detail');
    expect(within(detail).getByTestId('module-external').textContent).toContain('支付：stripe');
    expect(within(detail).getByTestId('env-var').textContent).toContain('STRIPE_KEY');
    fireEvent.click(screen.getAllByTestId('module-item')[0]!);
    expect(within(screen.getByTestId('module-detail')).getByTestId('module-responsibility').textContent).toBe('管理订单');
  });

  it('groups features by module in module-list order', async () => {
    vi.spyOn(api, 'overview').mockResolvedValue(response());
    renderPage();
    fireEvent.click(await screen.findByTestId('overview-view-features'));
    const groups = screen.getAllByTestId('feature-group');
    expect(groups.map((g) => g.dataset.module)).toEqual(['app/orders', 'app/users']);
    expect(within(groups[0]!).getAllByTestId('feature').map((f) => f.querySelector('h4')!.textContent)).toEqual(['下单', '退款']);
    expect(within(groups[0]!).getAllByTestId('feature-entry').map((b) => b.textContent)).toEqual(['POST /orders', 'POST /orders/{id}/refund']);
  });

  it('clicking an endpoint opens the neighbor graph in the current snapshot with callees expanded 2 levels', async () => {
    vi.spyOn(api, 'overview').mockResolvedValue(response());
    vi.spyOn(api, 'symbol').mockResolvedValue({ symbol: { ...info('create_order'), qualifiedName: 'orders.create_order' } } as never);
    const n = renderPage();
    fireEvent.click(await screen.findByTestId('overview-view-features'));
    fireEvent.click(screen.getAllByTestId('feature-entry')[0]!);
    await waitFor(() => expect(n.openGraph).toHaveBeenCalledWith({ snapshotId: 7, id: 'id-create_order', name: 'orders.create_order' }, 'browse', { expandCallees: 2 }));
    expect(api.symbol).toHaveBeenCalledWith(7, 'id-create_order');
  });

  it('says the symbol no longer exists instead of jumping when the current snapshot does not have it', async () => {
    vi.spyOn(api, 'overview').mockResolvedValue(response());
    vi.spyOn(api, 'symbol').mockRejectedValue(new ApiError(404, 'symbol_not_found', 'symbol_not_found'));
    const n = renderPage();
    fireEvent.click(await screen.findByTestId('overview-view-features'));
    fireEvent.click(screen.getAllByTestId('feature-entry')[0]!);
    expect((await screen.findByTestId('link-notice')).textContent).toBe('该符号在当前代码中已不存在：create_order');
    expect(n.openGraph).not.toHaveBeenCalled();
  });

  it('says the file no longer exists for a sample location missing from the current snapshot', async () => {
    vi.spyOn(api, 'overview').mockResolvedValue(response());
    vi.spyOn(api, 'source').mockRejectedValue(new ApiError(404, 'file_not_in_snapshot', 'file_not_in_snapshot'));
    const n = renderPage();
    fireEvent.click(await screen.findByTestId('overview-view-issues'));
    expect(screen.getAllByTestId('issue-group').map((g) => g.dataset.kind)).toEqual(['cycle', 'layer_violation']);
    fireEvent.click(screen.getAllByTestId('sample-location')[0]!);
    expect((await screen.findByTestId('link-notice')).textContent).toBe('该文件在当前代码中已不存在：app/orders/service.py');
    expect(n.openSourceAt).not.toHaveBeenCalled();
  });

  it('opens a sample location by path and line when the file exists', async () => {
    vi.spyOn(api, 'overview').mockResolvedValue(response());
    vi.spyOn(api, 'source').mockResolvedValue({} as never);
    const n = renderPage();
    fireEvent.click(await screen.findByTestId('overview-view-issues'));
    fireEvent.click(screen.getAllByTestId('sample-location')[0]!);
    await waitFor(() => expect(n.openSourceAt).toHaveBeenCalledWith({ snapshotId: 7, path: 'app/orders/service.py', start: 12, end: undefined }));
  });

  it('offers the newer structure-only overview and switches to it', async () => {
    const newer = response({ id: 5, overview: makeOverview({ system: undefined, llm: undefined }) });
    vi.spyOn(api, 'overview').mockImplementation(async (id) => (id === 5 ? newer : response({ newerStructureId: 5 })));
    renderPage();
    expect((await screen.findByTestId('overview-newer')).textContent).toContain('有更新的结构概览（不含 AI 说明）');
    fireEvent.click(screen.getByTestId('view-newer'));
    await waitFor(() => expect(screen.getByTestId('overview-viewing').textContent).toContain('#5'));
    expect(api.overview).toHaveBeenLastCalledWith(5);
    expect(screen.getByTestId('system-title').textContent).toBe('系统概览');
    fireEvent.click(screen.getByTestId('view-current'));
    await waitFor(() => expect(screen.getByTestId('system-title').textContent).toBe('商城系统'));
  });

  it('shows the stale notice when the code changed after the overview', async () => {
    vi.spyOn(api, 'overview').mockResolvedValue(response({ stale: true }));
    renderPage();
    expect((await screen.findByTestId('overview-stale')).textContent).toContain('代码已有变化');
  });
});

describe('generate dialog', () => {
  it('estimates only when opened, re-estimates without source, and confirms large runs with 仍然生成', async () => {
    const estimate = vi.spyOn(api, 'overviewEstimate').mockImplementation(async (p) => ({
      modules: 3, llmCalls: 5, cachedCalls: 2, inputTokens: p.noSource ? 300_000 : 900, outputTokens: 10,
      provider: 'anthropic', model: 'claude-x', sendSource: !p.noSource, needsConfirm: Boolean(p.noSource),
    }));
    const create = vi.spyOn(api, 'createOverview').mockResolvedValue({ id: 9 });
    vi.spyOn(api, 'overviewJob').mockResolvedValue({ id: 9, status: 'running', progress: { step: 'modules', done: 1, total: 3 }, createdAt: 1, finishedAt: null });
    renderPage(nav(), status({ overview: null }));
    expect(estimate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('overview-generate'));
    expect((await screen.findByTestId('overview-estimate')).textContent).toBe('将发送结构信息（含源码片段）到 anthropic（claude-x），预计 5 次请求，约 900 输入 token（2 次命中缓存）。');
    fireEvent.click(screen.getByTestId('overview-no-source'));
    await waitFor(() => expect(screen.getByTestId('overview-confirm').textContent).toBe('仍然生成'));
    expect(screen.getByTestId('overview-estimate').textContent).toContain('不含源码片段');
    fireEvent.click(screen.getByTestId('overview-confirm'));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ noSource: true, confirmed: true }));
    await waitFor(() => expect(screen.getByTestId('overview-progress').textContent).toBe('正在生成概览：生成模块说明（1 / 3）…'));
  });

  it('switches to 仍然生成 when the server answers needs_confirm', async () => {
    const est = { modules: 3, llmCalls: 5, cachedCalls: 0, inputTokens: 900, outputTokens: 10, provider: 'anthropic', model: 'claude-x', sendSource: true, needsConfirm: false };
    vi.spyOn(api, 'overviewEstimate').mockResolvedValue(est);
    const create = vi.spyOn(api, 'createOverview').mockRejectedValueOnce(new ApiError(409, 'needs_confirm', 'needs_confirm', { estimate: { ...est, needsConfirm: true } }));
    renderPage(nav(), status({ overview: null }));
    fireEvent.click(screen.getByTestId('overview-generate'));
    fireEvent.click(await screen.findByText('生成', { selector: 'button' }));
    await waitFor(() => expect(screen.getByTestId('overview-confirm').textContent).toBe('仍然生成'));
    expect(create).toHaveBeenCalledWith({ noSource: false });
  });

  it('disables the source checkbox when sending source is turned off by config', async () => {
    vi.spyOn(api, 'overviewEstimate').mockResolvedValue({ modules: 1, llmCalls: 1, cachedCalls: 0, inputTokens: 1, outputTokens: 1, provider: 'a', model: 'm', sendSource: false, needsConfirm: false });
    renderPage(nav(), status({ overview: null, sendSource: false }));
    fireEvent.click(screen.getByTestId('overview-generate'));
    const box = await screen.findByTestId<HTMLInputElement>('overview-no-source');
    expect(box.disabled && box.checked).toBe(true);
    await waitFor(() => expect(api.overviewEstimate).toHaveBeenCalledWith({ noSource: true }));
  });

  it('without an LLM explains how to configure one and generates the structure only', async () => {
    const estimate = vi.spyOn(api, 'overviewEstimate');
    const create = vi.spyOn(api, 'createOverview').mockResolvedValue({ id: 3 });
    vi.spyOn(api, 'overviewJob').mockResolvedValue({ id: 3, status: 'running', progress: null, createdAt: 1, finishedAt: null });
    renderPage(nav(), status({ overview: null, llm: null, llmConfigured: false }));
    fireEvent.click(screen.getByTestId('overview-generate'));
    expect(screen.getByTestId('llm-setup-help').textContent).toContain('CODEINSIGHT_LLM_PROVIDER');
    fireEvent.click(screen.getByText('生成结构概览（未配置 LLM）'));
    await waitFor(() => expect(create).toHaveBeenCalledWith({}));
    expect(estimate).not.toHaveBeenCalled();
  });

  it('shows who holds the running job', async () => {
    vi.spyOn(api, 'createOverview').mockRejectedValue(new ApiError(409, 'overview_running', 'overview_running', { pid: 4321 }));
    renderPage(nav(), status({ overview: null, llm: null }));
    fireEvent.click(screen.getByTestId('overview-generate'));
    fireEvent.click(screen.getByTestId('overview-confirm'));
    expect((await screen.findByTestId('overview-start-error')).textContent).toBe('已有概览任务在运行（pid 4321），请等它结束后再生成。');
  });
});

describe('useOverviewJob', () => {
  it('stops counting as running when reading the job fails for good (404), so generating can be retried', async () => {
    vi.spyOn(api, 'createOverview').mockResolvedValue({ id: 3 });
    const read = vi.spyOn(api, 'overviewJob').mockRejectedValue(new ApiError(404, 'job_not_found', 'job_not_found'));
    const { result } = renderHook(() => useOverviewJob(vi.fn()));
    await act(async () => void (await result.current.start({}, false)));
    await waitFor(() => expect(result.current.error).toBe('读取生成进度失败：job_not_found'));
    expect(result.current.running).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('expandCallees', () => {
  it('loads callees 2 levels deep and shows the second level without expanding', async () => {
    const center = info('center');
    const d1 = info('d1');
    vi.spyOn(api, 'callers').mockResolvedValue(tree(center, 'callers', []));
    const callees = vi.spyOn(api, 'callees').mockResolvedValue({
      ...tree(center, 'callees', [d1, { ...info('d2'), depth: 2 }], [
        { srcId: center.id, dstId: d1.id, kind: 'call', path: 'pkg/a.py', line: 2, col: 4 },
        { srcId: d1.id, dstId: 'id-d2', kind: 'call', path: 'pkg/a.py', line: 3, col: 4 },
      ]),
      depth: 2,
    });
    vi.spyOn(api, 'symbol').mockResolvedValue({ snapshotId: 1, resolverStatus: 'ok', symbol: { ...center, docstring: null, parent: null }, entries: [], callers: { total: 0, prod: 0, test: 0 }, callees: { total: 1, prod: 1, test: 0 } });
    render(
      <NavContext.Provider value={nav()}>
        <BrowseView currentSnapshotId={1} trail={[{ snapshotId: 1, id: center.id, name: 'center', expandCallees: 2 }]} onHome={vi.fn()} onPickCrumb={vi.fn()} />
      </NavContext.Provider>,
    );
    await waitFor(() => expect(screen.getAllByTestId('stub-node').map((n) => n.textContent)).toEqual(['center', 'd1', 'd2']));
    expect(callees).toHaveBeenCalledWith(1, center.id, 2);
    expect(screen.getAllByTestId('stub-node')[2]!.dataset.level).toBe('2');
  });
});

describe('default tab', () => {
  it('opens the overview when one exists, otherwise browse; decided by the first status only', () => {
    const { result, rerender } = renderHook(({ d }) => useNavigation(vi.fn(), d), { initialProps: { d: undefined as 'overview' | 'browse' | undefined } });
    expect(result.current.tab).toBe('browse');
    rerender({ d: 'overview' });
    expect(result.current.tab).toBe('overview');
    rerender({ d: 'browse' });
    expect(result.current.tab).toBe('overview');
    act(() => result.current.switchTab('review'));
    expect(result.current.tab).toBe('review');
  });

  it('openSourceAt without a JS bridge shows the file in the source panel', () => {
    const { result } = renderHook(() => useNavigation(vi.fn()));
    act(() => result.current.nav.openSourceAt({ snapshotId: 2, path: 'a.py', start: 5, end: 7 }));
    expect(result.current.source).toEqual({ snapshotId: 2, path: 'a.py', start: 5, end: 7 });
    window.codeinsightHost = { openFile: vi.fn() };
    act(() => result.current.nav.openSourceAt({ snapshotId: 2, path: 'b.py', start: 9 }));
    expect(window.codeinsightHost.openFile).toHaveBeenCalledWith('b.py', 9);
  });
});
