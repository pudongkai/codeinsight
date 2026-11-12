import { describe, expect, it } from 'vitest';
import { initNeighbors, mergeTree, PAGE_SIZE, visibleNeighbors, type ViewOptions } from '../src/browse/neighbor-model';
import { buildReportGraph } from '../src/report/report-graph';
import { callSites, splitLine } from '../src/source/call-sites';
import { change, info, makeReport, ref, tree } from './fixtures';

const view = (over: Partial<ViewOptions> = {}): ViewOptions => ({ showTests: false, showModels: true, pages: {}, ...over });
const names = (n: number, prefix = 'n') => Array.from({ length: n }, (_, i) => info(`${prefix}${String(i).padStart(2, '0')}`));

describe('neighbor graph model', () => {
  const center = info('center');
  it('puts callers and callees on their sides, expands a level further and hides test code by default', () => {
    const s0 = initNeighbors(1, tree(center, 'callers', [info('a'), info('t', { isTest: true })]), tree(center, 'callees', [info('c')]));
    expect(Object.values(s0.nodes).map((n) => [n.info.name, n.side, n.level])).toEqual([['center', 'center', 0], ['a', 'caller', 1], ['t', 'caller', 1], ['c', 'callee', 1]]);
    expect(visibleNeighbors(s0, view()).nodes.map((n) => n.info.name)).toEqual(['center', 'a', 'c']);
    expect(visibleNeighbors(s0, view({ showTests: true })).nodes).toHaveLength(4);
    const s1 = mergeTree(s0, tree(info('a'), 'callers', [info('b'), info('center')]), 'caller');
    expect(s1.nodes['id-b']).toMatchObject({ side: 'caller', level: 2, expanded: false, parent: 'id-a' });
    expect(s1.nodes['id-a']!.expanded).toBe(true);
    expect(s1.nodes['id-center']!.side).toBe('center');
  });

  it('pages each side of the center by PAGE_SIZE, production code first', () => {
    const callers = [...names(11), info('t', { isTest: true })];
    const s = initNeighbors(1, tree(center, 'callers', callers), tree(center, 'callees', names(3, 'd')));
    const v = visibleNeighbors(s, view({ showTests: true, pages: { 'caller:id-center': 1 } }));
    expect(v.nodes.filter((n) => n.side === 'caller').map((n) => n.info.name)).toEqual(['n05', 'n06', 'n07', 'n08', 'n09']);
    expect(v.groups['caller:id-center']).toMatchObject({ page: 1, pages: 3, total: 12 });
    expect(v.groups['callee:id-center']).toMatchObject({ page: 0, pages: 1, total: 3 });
    expect(v.edges.every((e) => v.nodes.some((n) => n.info.id === e.src))).toBe(true);
    const last = visibleNeighbors(s, view({ showTests: true, pages: { 'caller:id-center': 9 } }));
    expect(last.nodes.filter((n) => n.side === 'caller').map((n) => n.info.name)).toEqual(['n10', 't']);
    expect(PAGE_SIZE).toBe(5);
  });

  it('pages the next level of an expanded node and hides it with its parent', () => {
    const s0 = initNeighbors(1, tree(center, 'callers', names(6)), tree(center, 'callees', []));
    const s1 = mergeTree(s0, tree(info('n05'), 'callers', names(7, 'x')), 'caller');
    expect(visibleNeighbors(s1, view()).nodes.map((n) => n.info.name)).not.toContain('x00');
    const v = visibleNeighbors(s1, view({ pages: { 'caller:id-center': 1, 'caller:id-n05': 1 } }));
    expect(v.nodes.map((n) => n.info.name)).toEqual(['center', 'n05', 'x05', 'x06']);
    expect(v.groups['caller:id-n05']).toMatchObject({ page: 1, pages: 2, total: 7 });
  });

  it('hides model classes (never the center) and counts them separately', () => {
    const model = (name: string) => info(name, { kind: 'class', modelKind: 'pydantic' });
    const s = initNeighbors(1, tree(model('center'), 'callers', [...names(6), model('m1'), model('m2')]), tree(model('center'), 'callees', [model('m3')]));
    const v = visibleNeighbors(s, view({ showModels: false }));
    expect(v.nodes.map((n) => n.info.name)).toEqual(['center', 'n00', 'n01', 'n02', 'n03', 'n04']);
    expect(v.groups['caller:id-center']).toMatchObject({ total: 6, pages: 2, hiddenModels: 2 });
    expect(v.groups['callee:id-center']).toMatchObject({ total: 0, hiddenModels: 1 });
  });
});

describe('source call sites', () => {
  it('keeps only calls made by the function itself within its range and underlines the identifier at col', () => {
    const fn = info('g', { startLine: 9, endLine: 10 });
    const t = tree(fn, 'callees', [info('f')], [
      { srcId: fn.id, dstId: 'id-f', kind: 'call', path: 'pkg/a.py', line: 10, col: 11 },
      { srcId: fn.id, dstId: 'id-f', kind: 'import', path: 'pkg/a.py', line: 10, col: 2 },
      { srcId: 'other', dstId: 'id-f', kind: 'call', path: 'pkg/a.py', line: 10, col: 0 },
    ]);
    const sites = callSites(t, fn);
    expect(sites.map((s) => [s.line, s.col, s.target.name])).toEqual([[10, 11, 'f']]);
    expect(splitLine('    return f(1) + 2', sites)).toEqual([{ text: '    return ' }, { text: 'f', site: sites[0] }, { text: '(1) + 2' }]);
    expect(splitLine('', [])).toEqual([{ text: '' }]);
  });
});

describe('report structure graph', () => {
  it('can leave out model classes and their edges, counting them', () => {
    const report = makeReport({
      modules: [{ module: 'pkg', symbols: [change('Item', 'added', { kind: 'class', modelKind: 'pydantic' }), change('save', 'modified', { kind: 'method', callers: { prod: 1, test: 0, topProd: [ref('Order', { kind: 'class', modelKind: 'django' })] } })] }],
      edgeChanges: [{ src: ref('save'), dst: ref('Item', { kind: 'class', modelKind: 'pydantic' }), kind: 'call', change: 'added' }],
    });
    const all = buildReportGraph(report);
    expect(all.nodes.map((n) => n.label).sort()).toEqual(['Item', 'Order', 'save']);
    expect(all.nodes.find((n) => n.label === 'Item')!.marks!.map((m) => m.label)).toEqual(['模型']);
    expect(all.nodes.find((n) => n.label === 'save')!.marks!.map((m) => m.label)).toEqual(['方法']);
    const filtered = buildReportGraph(report, { showModels: false });
    expect(filtered.nodes.map((n) => n.label)).toEqual(['save']);
    expect(filtered.edges).toEqual([]);
    expect(filtered.hiddenModels).toBe(2);
  });

  it('draws changed functions, their top callers and edge changes with tones', () => {
    const g = buildReportGraph(makeReport());
    expect(g.nodes.map((n) => [n.label, n.tone]).sort()).toEqual([['caller_a', 'neighbor'], ['helper', 'neighbor'], ['new_fn', 'added'], ['old_fn', 'removed']]);
    expect(g.edges.map((e) => e.tone).sort()).toEqual(['added', 'normal']);
    expect(g.targets.get('k:pkg/a.py#function#old_fn#')!.target).toMatchObject({ side: 'base', removed: true });
  });
});
