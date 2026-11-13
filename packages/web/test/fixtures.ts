import type { OverviewModule, OverviewReport } from '@codeinsight/core/overview/types';
import type { ReviewReport, SymbolChange, SymbolRef } from '@codeinsight/core/report/types';
import { vi } from 'vitest';
import type { StatusResponse, SymbolInfo, TreeResponse } from '../src/api/types';
import type { Nav } from '../src/app/nav';

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

export function overviewModule(id: string, extra: Partial<OverviewModule> = {}): OverviewModule {
  return {
    id, dirs: [id], files: [`${id}/api.py`], size: 10, lines: 100, httpApis: 0, name: id.split('/').at(-1)!, aiStatus: 'none',
    interfaces: [], models: [], external: [], envVars: [], layers: {}, ...extra,
  };
}

const sample = (src: string, dst: string, path: string, line: number) => ({ src: ref(src, { path }), dst: ref(dst), path, line });

/** 三个模块：orders ↔ payments 循环依赖，users → orders 跨层调用 */
export function makeOverview(overrides: Partial<OverviewReport> = {}): OverviewReport {
  return {
    schemaVersion: 1, repo: '/repo', ref: 'working',
    snapshot: { contentKey: 'ck1', commitSha: 'a'.repeat(40), kind: 'working', createdAt: 1_700_000_000_000 },
    generatedAt: 1_700_000_100_000,
    llm: { provider: 'anthropic', model: 'claude-x', sendSource: true },
    system: { title: '商城系统', summary: '处理订单和支付。' },
    stats: { files: 10, testFiles: 1, modules: 3, functions: 30, httpApis: 3, models: 2 },
    modules: [
      overviewModule('app/orders', { name: '订单', responsibility: '管理订单', aiStatus: 'ok', external: [{ category: 'database', libs: ['psycopg'], files: ['app/orders/repository.py'] }] }),
      overviewModule('app/payments', { name: '支付', aiStatus: 'failed', external: [{ category: 'payment', libs: ['stripe'], files: ['app/payments/service.py'] }], envVars: [{ name: 'STRIPE_KEY', files: ['app/payments/service.py'] }] }),
      overviewModule('app/users', { aiStatus: 'cached' }),
    ],
    moduleEdges: [
      { from: 'app/orders', to: 'app/payments', weight: 3, kinds: ['call'], samples: [sample('create_order', 'charge', 'app/orders/service.py', 12)], inCycle: true },
      { from: 'app/payments', to: 'app/orders', weight: 1, kinds: ['call', 'import'], samples: [], inCycle: true },
      { from: 'app/users', to: 'app/orders', weight: 0, kinds: ['import'], samples: [], inCycle: false },
    ],
    external: [{ category: 'database', libs: ['psycopg'], modules: ['app/orders'] }],
    features: [
      { id: 'f1', module: 'app/orders', name: '下单', description: '创建订单', entries: [{ symbol: ref('create_order', { id: 'id-create_order' }), kind: 'http', method: 'POST', path: '/orders' }] },
      { id: 'f2', module: 'app/users', name: '用户', entries: [{ symbol: ref('get_user'), kind: 'http', method: 'GET', path: '/users/{id}' }] },
      { id: 'f3', module: 'app/orders', name: '退款', entries: [{ symbol: ref('refund'), kind: 'http', method: 'POST', path: '/orders/{id}/refund' }] },
    ],
    issues: [
      { kind: 'cycle', severity: 'warning', modules: ['app/orders', 'app/payments'], message: '循环依赖', samples: [sample('create_order', 'charge', 'app/orders/service.py', 12)] },
      { kind: 'layer_violation', severity: 'warning', modules: ['app/users', 'app/orders'], message: '跨层', samples: [] },
    ],
    ai: { calls: 3, cached: 1, failed: 1, inputTokens: 100, outputTokens: 50 },
    warnings: [],
    ...overrides,
  };
}

/** 每个方法都是 vi.fn() 的 Nav */
export const makeNav = (): Nav => ({ openSymbol: vi.fn(), showSource: vi.fn(), openSourceAt: vi.fn(), openGraph: vi.fn(), snapshotGone: vi.fn(), indexNotReady: vi.fn() });

/** 已配置 anthropic、有快照（id 7，content_key ck1）和概览的 /api/status */
export function makeStatus(extra: Partial<StatusResponse> = {}): StatusResponse {
  return {
    repo: '/repo', repoGen: 1, repoLocked: false, dirPickerAvailable: true, changes: { checkedAt: null, codeChanged: false, autoReindex: false, autoReindexFailed: false },
    node: 'v22', llmConfigured: true, llm: { provider: 'anthropic', model: 'claude-x' }, sendSource: true,
    index: { job: null, lastDoneAt: 1 },
    snapshot: { id: 7, kind: 'working', commitSha: 'a'.repeat(40), contentKey: 'ck1', createdAt: 1, resolverStatus: 'ok', resolverError: null, dirty: false },
    reviews: [], overview: { id: 1, createdAt: 1, stale: false }, ...extra,
  };
}
