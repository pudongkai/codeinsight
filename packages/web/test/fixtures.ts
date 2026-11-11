import type { ReviewReport, SymbolChange, SymbolRef } from '@codeinsight/core/report/types';
import type { SymbolInfo, TreeResponse } from '../src/api/types';

export function ref(name: string, extra: Partial<SymbolRef> = {}): SymbolRef {
  return { key: `pkg/a.py#function#${name}#`, id: `id-${name}`, kind: 'function', name, qualifiedName: name, path: 'pkg/a.py', startLine: 1, isTest: false, ...extra };
}

export function change(name: string, kind: SymbolChange['change'], extra: Partial<SymbolChange> = {}): SymbolChange {
  return {
    ...ref(name), endLine: 3, change: kind, displaySignature: '()',
    callers: { prod: 0, test: 0, topProd: [] }, impact: { depth: 2, prod: 0, test: 0 }, ...extra,
  };
}

export function makeReport(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    schemaVersion: 1,
    repo: '/repo',
    base: { ref: 'HEAD', sha: 'a'.repeat(40), snapshotId: 1 },
    head: { ref: 'WORKING', sha: 'a'.repeat(40), working: true, snapshotId: 2 },
    files: [{ path: 'pkg/a.py', status: 'modified', language: 'python', supportLevel: 'full', additions: 3, deletions: 1, isTest: false }],
    modules: [
      {
        module: 'pkg',
        symbols: [
          change('new_fn', 'added', { startLine: 10, entry: { kind: 'http', framework: 'fastapi', detail: { method: 'POST', path: '/orders' } } }),
          change('old_fn', 'removed', { startLine: 20, callers: { prod: 2, test: 1, topProd: [ref('caller_a', { startLine: 30 })] } }),
        ],
      },
    ],
    edgeChanges: [{ src: ref('new_fn'), dst: ref('helper'), kind: 'call', change: 'added' }],
    duplicates: [],
    warnings: [{ code: 'llm_not_configured', level: 'info', message: 'no LLM configured' }],
    ...overrides,
  };
}

export function info(name: string, extra: Partial<SymbolInfo> = {}): SymbolInfo {
  return { id: `id-${name}`, key: `k-${name}`, kind: 'function', name, qualifiedName: name, displaySignature: '()', path: 'pkg/a.py', startLine: 1, endLine: 5, isTest: false, ...extra };
}

export function tree(root: SymbolInfo, direction: 'callers' | 'callees', nodes: (SymbolInfo & { depth?: number })[], edges: TreeResponse['edges'] = []): TreeResponse {
  return {
    snapshotId: 1, resolverStatus: 'ok', direction, depth: 1, root,
    nodes: nodes.map((n) => ({ ...n, depth: n.depth ?? 1 })),
    edges: edges.length > 0 ? edges : nodes.map((n) => (direction === 'callers' ? { srcId: n.id, dstId: root.id } : { srcId: root.id, dstId: n.id })).map((e) => ({ ...e, kind: 'call', path: 'pkg/a.py', line: 2, col: 4 })),
  };
}
