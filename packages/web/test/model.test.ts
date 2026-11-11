import { describe, expect, it } from 'vitest';
import { initNeighbors, MAX_PER_SIDE, mergeTree, visibleNeighbors } from '../src/browse/neighbor-model';
import { buildReportGraph } from '../src/report/report-graph';
import { callSites, splitLine } from '../src/source/call-sites';
import { info, makeReport, tree } from './fixtures';

describe('neighbor graph model', () => {
  const center = info('center');
  it('puts callers and callees on their sides, expands a level further and hides test code by default', () => {
    const s0 = initNeighbors(1, tree(center, 'callers', [info('a'), info('t', { isTest: true })]), tree(center, 'callees', [info('c')]));
    expect(Object.values(s0.nodes).map((n) => [n.info.name, n.side, n.level])).toEqual([['center', 'center', 0], ['a', 'caller', 1], ['t', 'caller', 1], ['c', 'callee', 1]]);
    expect(visibleNeighbors(s0, false).nodes.map((n) => n.info.name)).toEqual(['center', 'a', 'c']);
    expect(visibleNeighbors(s0, true).nodes).toHaveLength(4);
    const s1 = mergeTree(s0, tree(info('a'), 'callers', [info('b'), info('center')]), 'caller');
    expect(s1.nodes['id-b']).toMatchObject({ side: 'caller', level: 2, expanded: false });
    expect(s1.nodes['id-a']!.expanded).toBe(true);
    expect(s1.nodes['id-center']!.side).toBe('center');
  });

  it('collapses more than MAX_PER_SIDE nodes on one side into overflow', () => {
    const many = Array.from({ length: MAX_PER_SIDE + 5 }, (_, i) => info(`n${String(i).padStart(2, '0')}`));
    const v = visibleNeighbors(initNeighbors(1, tree(center, 'callers', many), tree(center, 'callees', [])), false);
    expect(v.nodes.filter((n) => n.side === 'caller')).toHaveLength(MAX_PER_SIDE);
    expect(v.overflow.caller.map((n) => n.info.name)).toEqual(['n30', 'n31', 'n32', 'n33', 'n34']);
    expect(v.edges.every((e) => v.nodes.some((n) => n.info.id === e.src))).toBe(true);
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
  it('draws changed functions, their top callers and edge changes with tones', () => {
    const g = buildReportGraph(makeReport());
    expect(g.nodes.map((n) => [n.label, n.tone]).sort()).toEqual([['caller_a', 'neighbor'], ['helper', 'neighbor'], ['new_fn', 'added'], ['old_fn', 'removed']]);
    expect(g.edges.map((e) => e.tone).sort()).toEqual(['added', 'normal']);
    expect(g.targets.get('k:pkg/a.py#function#old_fn#')!.target).toMatchObject({ side: 'base', removed: true });
  });
});
