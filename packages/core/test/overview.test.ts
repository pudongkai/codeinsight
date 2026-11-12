import { cpSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyFeatureNames, buildSnapshot, classifyExternal, collectExternal, collectImportModules, computeStructure, externalLibs,
  externalTable, firstPathSegment, getPythonParser, initDataDir, loadConfig, makeFeature, moduleMarkdown, moduleSnippets,
  overviewMarkdown, projectPackages, Store, structureReport,
} from '../src/index.js';
import type { FileRow, OverviewReport, OverviewStructure, SymbolRow } from '../src/index.js';
import { commitAll, git, initRepo, tempDir, writeFiles } from './helpers/git-repo.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'py-shop');
const SMALL = { moduleMinSize: 3, moduleMaxSize: 15, leafSplitSize: 8 };

const stores: Store[] = [];
afterAll(() => {
  for (const s of stores) s.close();
});

interface Indexed {
  store: Store;
  structure: OverviewStructure;
  report: OverviewReport;
}

/** 建工作区快照并算结构部分；overview 写进仓库配置 */
async function structureOf(repo: string, overview: Record<string, unknown>): Promise<Indexed> {
  writeFileSync(path.join(repo, 'codeinsight.config.json'), JSON.stringify({ overview }));
  const config = await loadConfig(repo, { dataDir: tempDir('ci-ov-data-'), env: {} });
  const layout = await initDataDir(config.dataDir);
  const store = new Store(layout.dbPath);
  stores.push(store);
  const { snapshot } = await buildSnapshot({ repo, store, layout, config });
  expect(snapshot.resolverStatus).toBe('ok');
  const structure = await computeStructure({ repo, store, layout, snapshot, config });
  expect(await computeStructure({ repo, store, layout, snapshot, config })).toBe(structure);
  return { store, structure, report: structureReport(structure, { repo, ref: 'working', now: 1 }) };
}

function shopRepo(changes: Record<string, string | null> = {}): string {
  const repo = tempDir('ci-ov-shop-');
  cpSync(FIXTURE, repo, { recursive: true });
  writeFiles(repo, changes);
  git(repo, 'init', '-q', '-b', 'main');
  commitAll(repo, 'init');
  return repo;
}

const mod = (r: OverviewReport, id: string) => r.modules.find((m) => m.id === id)!;

describe('overview structure on py-shop', () => {
  let shop: Indexed;
  beforeAll(async () => {
    shop = await structureOf(shopRepo(), SMALL);
  }, 120_000);

  it('counts module edge weight from call / reference edges only, matching the edges table', () => {
    const { structure, report, store } = shop;
    const snapId = structure.snapshot.id;
    const syms = new Map(store.getSymbols(snapId).map((s) => [s.id, s]));
    const byPath = structure.partition.index.byPath;
    const expected = new Map<string, Set<string>>();
    for (const e of store.getEdges(snapId)) {
      const [src, dst] = [syms.get(e.srcId)!, syms.get(e.dstId)!];
      if ((e.kind !== 'call' && e.kind !== 'reference') || src.isTest || dst.isTest) continue;
      const [from, to] = [byPath.get(src.path), byPath.get(dst.path)];
      if (!from || !to || from === to) continue;
      const k = `${from}>${to}`;
      if (!expected.has(k)) expected.set(k, new Set());
      expected.get(k)!.add(`${e.srcId}>${e.dstId}`);
    }
    const weighted = report.moduleEdges.filter((e) => e.weight > 0);
    expect(new Map(weighted.map((e) => [`${e.from}>${e.to}`, e.weight]))).toEqual(new Map([...expected].map(([k, v]) => [k, v.size])));
    const importOnly = report.moduleEdges.find((e) => e.from === 'app/*' && e.to === 'app/orders')!;
    expect(importOnly).toMatchObject({ weight: 0, kinds: ['import'], samples: [] });
    for (const e of weighted) expect(e.samples.length).toBeGreaterThan(0);
  });

  it('finds external libraries and environment variables per module', () => {
    const { report } = shop;
    const ext = (id: string) => Object.fromEntries(mod(report, id).external.map((e) => [e.category, e.libs]));
    expect(ext('app/payments')).toMatchObject({ payment: ['stripe'], http_client: ['httpx'] });
    expect(ext('app/orders')).toMatchObject({ database: ['psycopg'] });
    // common/settings.py 没有函数和类，import 和环境变量仍算在 common 模块里
    const common = mod(report, 'app/common');
    expect(common.files).toContain('app/common/settings.py');
    expect(common.external).toEqual([{ category: 'database', libs: ['psycopg_pool'], files: ['app/common/settings.py'] }]);
    expect(common.envVars).toEqual([
      { name: 'DATABASE_URL', files: ['app/common/settings.py'] },
      { name: 'STRIPE_KEY', files: ['app/common/settings.py'] },
    ]);
    // email.mime 算 email，只用 email.utils 的 parse.py 不算
    expect(mod(report, 'app/users').external.find((e) => e.category === 'email')).toEqual({ category: 'email', libs: ['email.mime'], files: ['app/users/mailer.py'] });
    expect(report.external.find((e) => e.category === 'database')).toEqual({ category: 'database', libs: ['psycopg', 'psycopg_pool'], modules: ['app/common', 'app/orders'] });
    // 项目内的包不算外部依赖
    expect(report.external.flatMap((e) => e.libs).filter((l) => l === 'app' || l.startsWith('app.'))).toEqual([]);
  });

  it('finds exactly the four expected boundary issues', () => {
    const { report } = shop;
    const issues = report.issues.map((i) => ({ kind: i.kind, severity: i.severity, modules: i.modules, samples: i.samples.map((s) => `${s.src.qualifiedName}>${s.dst.qualifiedName}`) }));
    expect(issues).toEqual([
      { kind: 'cycle', severity: 'warning', modules: ['app/orders', 'app/payments'], samples: ['create_order>charge', 'refund>refund_payment', 'handle_webhook>mark_paid'] },
      { kind: 'layer_violation', severity: 'warning', modules: ['app/payments'], samples: ['record_payment>notify'] },
      { kind: 'layer_skip', severity: 'info', modules: ['app/orders'], samples: ['get_order>load_order'] },
      { kind: 'private_access', severity: 'info', modules: ['app/users', 'app/orders'], samples: ['quote_for_user>_calc'] },
    ]);
    expect(report.moduleEdges.filter((e) => e.inCycle).map((e) => `${e.from}>${e.to}`)).toEqual(['app/orders>app/payments', 'app/payments>app/orders']);
    expect(mod(report, 'app/orders').layers).toEqual({ entry: ['app/orders/api.py'], data: ['app/orders/repository.py'], service: ['app/orders/service.py'] });
    expect(report.warnings).toEqual([]);
  });

  it('lists interfaces, models and stats', () => {
    const { report } = shop;
    const orders = mod(report, 'app/orders');
    // HTTP 接口优先，其后是被其他模块调用的公开函数；私有的 _calc 不列出
    expect(orders.interfaces.map((i) => i.symbol.name)).toEqual(['create_order', 'get_order', 'refund_order', 'mark_paid']);
    expect(orders.interfaces[3]).toMatchObject({ inbound: 1, fromModules: ['app/payments'] });
    expect(orders.models.map((m) => m.symbol.name).sort()).toEqual(['OrderIn', 'OrderOut']);
    expect(report.stats).toEqual({ files: 26, testFiles: 1, modules: 9, functions: 50, httpApis: 5, models: 4 });
    expect(mod(report, 'app/users')).toMatchObject({ name: 'users', aiStatus: 'none', dirs: ['app/tiny', 'app/users'] });
  });

  it('groups HTTP entries by handler file', () => {
    const { report } = shop;
    expect(report.features.map((f) => [f.module, f.name, f.entries.map((e) => `${e.method} ${e.path}`)])).toEqual([
      ['app/orders', 'api /orders', ['POST /orders', 'GET /orders/{order_id}', 'POST /orders/{order_id}/refund']],
      ['app/payments', 'api /payments', ['POST /payments/webhook']],
      ['app/users', 'api /users', ['GET /users/{user_id}']],
    ]);
    const orders = report.features[0]!;
    expect(orders.id).toBe(`app/orders:${orders.entries[0]!.symbol.id}`);
  });

  it('picks source snippets HTTP-first, without line numbers', () => {
    const { structure } = shop;
    const orders = structure.snippets.get('app/orders')!;
    expect(orders.length).toBeLessThanOrEqual(6);
    expect(orders.slice(0, 3).map((s) => s.key.split('#')[2])).toEqual(['create_order', 'get_order', 'refund_order']);
    expect(orders[0]!.code.startsWith('@router.post("/orders")\ndef create_order(')).toBe(true);
    // 不在本模块的函数、私有函数都不进片段
    expect(orders.some((s) => s.key.includes('_calc'))).toBe(false);
  });

  it('renders the overview and a single module as Markdown', () => {
    const { report } = shop;
    const md = overviewMarkdown(report);
    for (const text of ['## 模块', '`app/orders`', '## 外部依赖', 'psycopg_pool', '## 功能', '## 边界问题', 'private_access']) expect(md).toContain(text);
    const common = moduleMarkdown(report, 'common')!;
    expect(common).toContain('`DATABASE_URL`');
    expect(common).toContain('**database**：psycopg_pool');
    expect(moduleMarkdown(report, 'nope')).toBeUndefined();
  });
});

/** 9 个接口在同一个文件里：路径第一段（跳过 api、v1 和路径参数）为 reports 的 5 个、stats 的 4 个 */
function adminApi(): string {
  const routes = [
    ...['daily', 'weekly', 'monthly', 'yearly', 'export'].map((n) => [`/api/v1/reports/${n}`, `report_${n}`]),
    ...['visits', 'sales', 'refunds', 'signups'].map((n) => [`/{tenant}/stats/${n}`, `stats_${n}`]),
  ];
  return ['from fastapi import APIRouter', '', 'router = APIRouter()', '', ...routes.flatMap(([p, fn]) => [
    '', `@router.get("${p}")`, `def ${fn}() -> dict:`, '    return {}', '',
  ])].join('\n');
}

const PAYMENTS_REPO_WITH_MODEL = `from app.payments import service
from app.payments.api import PaymentEvent


def record_payment(order_id: int, status: str) -> None:
    service.notify(order_id, status)


def find_payment(order_id: int) -> dict:
    return {"order_id": order_id}


def to_event(order_id: int) -> PaymentEvent:
    return PaymentEvent(order_id=order_id, status="new")
`;

describe('overview structure on a changed py-shop', () => {
  let shop: Indexed;
  beforeAll(async () => {
    const repo = shopRepo({ 'app/orders/admin_api.py': adminApi(), 'app/payments/repository.py': PAYMENTS_REPO_WITH_MODEL });
    shop = await structureOf(repo, { moduleMinSize: 3, moduleMaxSize: 40, leafSplitSize: 40 });
  }, 120_000);

  it('splits a file with more than 8 HTTP entries by the first path segment', () => {
    const admin = shop.report.features.filter((f) => f.entries[0]!.symbol.path === 'app/orders/admin_api.py');
    expect(admin.map((f) => [f.name, f.entries.length])).toEqual([['admin_api /reports', 5], ['admin_api /stats', 4]]);
    const http = shop.structure.stats.httpApis;
    expect(shop.report.features.flatMap((f) => f.entries)).toHaveLength(http);
  });

  it('does not count a data-layer reference to a model class as a layer violation', () => {
    const violations = shop.report.issues.filter((i) => i.kind === 'layer_violation');
    expect(violations.flatMap((i) => i.samples.map((s) => `${s.src.qualifiedName}>${s.dst.qualifiedName}`))).toEqual(['record_payment>notify']);
  });
});

describe('overview structure without any layer', () => {
  it('skips layer checks and warns layers_not_detected', async () => {
    const repo = initRepo({
      'pkg/__init__.py': '',
      'pkg/alpha.py': 'from pkg.beta import b1\n\n\ndef a1():\n    return b1()\n\n\ndef a2():\n    return 2\n\n\ndef a3():\n    return a2()\n',
      'pkg/beta.py': 'def b1():\n    return 1\n\n\ndef b2():\n    return 2\n\n\ndef b3():\n    return b2()\n',
    });
    const { report } = await structureOf(repo, {});
    expect(report.warnings.map((w) => w.code)).toEqual(['layers_not_detected']);
    expect(report.issues).toEqual([]);
    expect(report.features).toEqual([]);
  }, 120_000);
});

describe('external dependency classification', () => {
  const table = externalTable();

  it('matches the longest dotted prefix', () => {
    expect(classifyExternal(table, 'django.db.models')).toEqual({ lib: 'django.db', category: 'database' });
    expect(classifyExternal(table, 'django')).toEqual({ lib: 'django', category: 'web_framework' });
    expect(classifyExternal(table, 'django.http')).toEqual({ lib: 'django', category: 'web_framework' });
    expect(classifyExternal(table, 'psycopg_pool')).toEqual({ lib: 'psycopg_pool', category: 'database' });
    expect(classifyExternal(table, 'psycopg.errors')).toEqual({ lib: 'psycopg', category: 'database' });
    expect(classifyExternal(table, 'google.cloud', ['google.cloud.storage'])).toEqual({ lib: 'google.cloud.storage', category: 'storage' });
    expect(classifyExternal(table, 'email.mime.text')).toEqual({ lib: 'email.mime', category: 'email' });
    // 标准库不列出；没匹配上的第三方库归 other，库名取第一段
    expect(classifyExternal(table, 'email.utils')).toBeUndefined();
    expect(classifyExternal(table, 'json')).toBeUndefined();
    expect(classifyExternal(table, 'pydantic.fields')).toEqual({ lib: 'pydantic', category: 'other' });
    expect(classifyExternal(externalTable({ 'acme.mq': 'message_queue' }), 'acme.mq.client')).toEqual({ lib: 'acme.mq', category: 'message_queue' });
  });

  it('collects full dotted import names and skips relative and project imports', async () => {
    const parser = await getPythonParser();
    const tree = parser.parse([
      'import a.b.c', 'import x.y as z', 'from p.q import r, s as t', 'from . import sibling', 'from ..models import M',
      'from app.orders import service', 'import stripe', 'from __future__ import annotations',
    ].join('\n'))!;
    const imports = collectImportModules(tree.rootNode);
    tree.delete();
    expect(imports).toEqual([
      { module: 'a.b.c', relative: false, candidates: [] },
      { module: 'x.y', relative: false, candidates: [] },
      { module: 'p.q', relative: false, candidates: ['p.q.r', 'p.q.s'] },
      { module: '.', relative: true, candidates: [] },
      { module: '..models', relative: true, candidates: [] },
      { module: 'app.orders', relative: false, candidates: ['app.orders.service'] },
      { module: 'stripe', relative: false, candidates: [] },
    ]);
    const libs = externalLibs(imports, new Set(['app', 'a']), table);
    expect(libs).toEqual([{ lib: 'x', category: 'other' }, { lib: 'p', category: 'other' }, { lib: 'stripe', category: 'payment' }]);
  });

  it('treats first path segments and package directory names as project packages', () => {
    const file = (p: string, language = 'python') => ({ path: p, language }) as FileRow;
    const pkgs = projectPackages([file('server/modules/billing/__init__.py'), file('server/main.py'), file('run.py'), file('web/app.ts', 'typescript')]);
    expect([...pkgs].sort()).toEqual(['billing', 'run', 'server']);
  });

  it('collects literal environment variable names and pydantic settings fields', async () => {
    const source = [
      'import os', 'from os import environ', 'from pydantic_settings import BaseSettings', '',
      'A = os.environ["ENV_A"]', 'B = os.environ.get("ENV_B", "x")', 'C = os.getenv("ENV_C")', 'D = environ.get("ENV_D")',
      'E = environ["ENV_E"]', 'name = "X"', 'F = os.getenv(f"PREFIX_{name}")', 'G = os.getenv("A" + name)', '',
      'class Settings(BaseSettings):', '    db_url: str = "x"', '    pool_size: int', '    _private: int = 0', '',
      'class Other:', '    not_env: str = "x"',
    ].join('\n');
    const { byModule } = await collectExternal({ modules: [{ id: 'm', files: ['m/settings.py'] }], files: [], read: async () => source, table });
    expect(byModule.get('m')!.envVars.map((e) => e.name)).toEqual(['DB_URL', 'ENV_A', 'ENV_B', 'ENV_C', 'ENV_D', 'ENV_E', 'POOL_SIZE']);
    expect(byModule.get('m')!.external).toEqual([{ category: 'other', libs: ['pydantic_settings'], files: ['m/settings.py'] }]);
  });

  it('skips files that cannot be read and adds a warning', async () => {
    const read = async () => {
      throw new Error('boom');
    };
    const r = await collectExternal({ modules: [{ id: 'm', files: ['m/a.py'] }], files: [], read, table });
    expect(r.byModule.get('m')).toEqual({ external: [], envVars: [] });
    expect(r.warnings.map((w) => w.code)).toEqual(['external_files_skipped']);
  });
});

describe('feature helpers', () => {
  it('takes the first path segment, skipping parameters, api and version segments', () => {
    expect(firstPathSegment('/api/v2/orders/{id}')).toBe('orders');
    expect(firstPathSegment('/{tenant}/stats')).toBe('stats');
    expect(firstPathSegment('<int:pk>/edit/')).toBe('edit');
    expect(firstPathSegment('/')).toBe('');
  });

  it('applies LLM feature names: drops unknown keys, keeps the first of duplicates, restores uncovered entries', () => {
    const entry = (key: string) => ({ symbol: { key, id: `id-${key}`, kind: 'function', name: key, qualifiedName: key, path: 'm/api.py', startLine: 1, isTest: false }, kind: 'http' as const });
    const defaults = [makeFeature('m', 'api /a', [entry('k1'), entry('k2')]), makeFeature('m', 'api /b', [entry('k3')])];
    const out = applyFeatureNames('m', defaults, [
      { name: '下单', description: '创建订单', entryKeys: ['k1', 'ghost', 'k1'] },
      { name: '重复', entryKeys: ['k1'] },
      { name: '查询', entryKeys: ['k2'] },
    ]);
    expect(out.map((f) => [f.name, f.entries.map((e) => e.symbol.key)])).toEqual([['下单', ['k1']], ['查询', ['k2']], ['api /b', ['k3']]]);
    expect(out[0]).toMatchObject({ id: 'm:id-k1', description: '创建订单' });
  });
});

describe('module snippets', () => {
  const sym = (name: string, startLine: number, endLine: number, kind = 'function') =>
    ({ symbolKey: `m.py#${kind}#${name}#`, name, kind, path: 'm.py', startLine, endLine }) as SymbolRow;
  const source = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
  const read = async () => source;

  it('limits the count and lines per snippet and skips classes', async () => {
    const ranked = [sym('Klass', 1, 2, 'class'), sym('f', 1, 10), sym('g', 11, 12), sym('h', 13, 14)];
    const out = await moduleSnippets('m', ranked, read, { perModule: 2, maxLines: 3, maxCharsPerModule: 10_000 });
    expect(out).toEqual([
      { key: 'm.py#function#f#', code: 'line 1\nline 2\nline 3\n# ...（省略 7 行）' },
      { key: 'm.py#function#g#', code: 'line 11\nline 12' },
    ]);
  });

  it('stops before the module total exceeds maxCharsPerModule', async () => {
    const ranked = [sym('f', 1, 2), sym('g', 3, 4), sym('h', 5, 6)];
    const out = await moduleSnippets('m', ranked, read, { perModule: 6, maxLines: 60, maxCharsPerModule: 30 });
    expect(out.map((s) => s.code)).toEqual(['line 1\nline 2', 'line 3\nline 4']);
  });
});
