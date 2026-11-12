import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSnapshot, initDataDir, loadConfig, moduleDirs, setLogSink, Store } from '../src/index.js';
import type { EdgeRow, FileRow, SymbolRow } from '../src/index.js';
import { loadPartitionInput, partition } from '../src/overview/partition.js';
import type { PartitionInput, PartitionResult } from '../src/overview/partition.js';
import {
  DEFAULT_PARTITION_THRESHOLDS, partitionRecordPath, readPartitionRecord, writePartitionRecord,
} from '../src/overview/partition-state.js';
import type { PartitionRecord, PartitionThresholds } from '../src/overview/partition-state.js';
import { commitAll, git, tempDir, writeFiles } from './helpers/git-repo.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'py-shop');
const TH: PartitionThresholds = { moduleMinSize: 3, moduleMaxSize: 15, leafSplitSize: 8 };

type Snapshot = Pick<PartitionInput, 'files' | 'symbols' | 'edges'>;

/** 复制 fixtures 成临时仓库，按 changes 改动工作区后建工作区快照 */
async function indexShop(changes: Record<string, string | null> = {}): Promise<Snapshot> {
  const repo = tempDir('ci-shop-');
  cpSync(FIXTURE, repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  commitAll(repo, 'init');
  writeFiles(repo, changes);
  const config = await loadConfig(repo, { dataDir: tempDir('ci-shop-data-'), env: {} });
  const layout = await initDataDir(config.dataDir);
  const store = new Store(layout.dbPath);
  try {
    const { snapshot } = await buildSnapshot({ repo, store, layout, config });
    expect(snapshot.resolverStatus).toBe('ok');
    return loadPartitionInput(store, snapshot.id);
  } finally {
    store.close();
  }
}

function moduleFiles(r: PartitionResult): Record<string, string[]> {
  return Object.fromEntries(r.modules.map((m) => [m.id, m.files]));
}

const logLines: string[] = [];
let restoreSink: ((line: string) => void) | undefined;
const logLevel = process.env.CODEINSIGHT_LOG;
beforeAll(() => {
  process.env.CODEINSIGHT_LOG = 'debug';
  restoreSink = setLogSink((line) => logLines.push(line));
});
afterAll(() => {
  if (restoreSink) setLogSink(restoreSink);
  if (logLevel === undefined) delete process.env.CODEINSIGHT_LOG;
  else process.env.CODEINSIGHT_LOG = logLevel;
});

describe('partition on py-shop', () => {
  let base: Snapshot;
  let first: PartitionResult;
  beforeAll(async () => {
    base = await indexShop();
    first = partition({ ...base, thresholds: TH, now: 1 });
  }, 120_000);

  it('builds the expected modules: tiny merged, big split by files, tests excluded', () => {
    expect(first.modules.map((m) => [m.id, m.kind, m.size])).toEqual([
      ['*', 'rest', 0],
      ['app/*', 'files', 3],
      ['app/big#a', 'cluster', 8],
      ['app/big#c', 'cluster', 8],
      ['app/common', 'dir', 3],
      ['app/leaf', 'dir', 5],
      ['app/orders', 'dir', 12],
      ['app/payments', 'dir', 8],
      ['app/users', 'dir', 7],
    ]);
    const files = moduleFiles(first);
    expect(files['app/users']).toContain('app/tiny/one.py');
    expect(first.modules.find((m) => m.id === 'app/users')!.mergedFrom).toEqual(['app/tiny']);
    expect(files['app/big#a']).toEqual(['app/big/__init__.py', 'app/big/a.py', 'app/big/b.py']);
    expect(files['app/big#c']).toEqual(['app/big/c.py', 'app/big/d.py']);
    expect(first.index.byPath.has('tests/test_orders.py')).toBe(false);
    expect(first.stats).toMatchObject({ testFiles: 1 });
    const testSyms = base.symbols.filter((s) => s.path === 'tests/test_orders.py');
    expect(testSyms.every((s) => !first.index.bySymbol.has(s.id))).toBe(true);
  });

  it('puts files without symbols into the module covering their directory, or an ancestor\'s', () => {
    const at = (p: string) => first.index.byPath.get(p);
    expect(at('app/common/settings.py')).toBe('app/common');
    expect(at('app/common/__init__.py')).toBe('app/common');
    expect(at('app/orders/__init__.py')).toBe('app/orders');
    expect(at('app/config/__init__.py')).toBe('app/*');
    expect(at('app/__init__.py')).toBe('app/*');
    expect(at('run.py')).toBe('*');
    expect(first.record.clusters['app/big/__init__.py']).toBe('app/big#a');
    // 每个参与划分的文件恰好属于一个模块
    const all = first.modules.flatMap((m) => m.files);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(first.stats.files);
  });

  it('gives the same result twice without a record, and again when following its own record', () => {
    const again = partition({ ...base, thresholds: TH, now: 1 });
    expect(again.modules).toEqual(first.modules);
    expect(again.record).toEqual(first.record);
    const replay = partition({ ...base, thresholds: TH, record: first.record, now: 2 });
    expect(replay.modules).toEqual(first.modules);
    expect(replay.recordChanged).toBe(false);
    expect(replay.record).toEqual(first.record);
  });

  it('accepts a record written before direct and keep-alone decisions were recorded', () => {
    const old: PartitionRecord = { ...first.record, merges: Object.fromEntries(Object.entries(first.record.merges).filter(([, v]) => v !== null)) };
    delete old.direct;
    delete old.directSizes;
    delete old.mergeSizes;
    const r = partition({ ...base, thresholds: TH, record: old });
    expect(r.modules).toEqual(first.modules);
    expect(r.record.direct).toEqual(first.record.direct);
    expect(r.record.merges).toEqual(first.record.merges);
  });

  it('keeps id app/leaf on both sides of moduleMaxSize', () => {
    const split = partition({ ...base, thresholds: { ...TH, moduleMaxSize: 4 } });
    const whole = partition({ ...base, thresholds: { ...TH, moduleMaxSize: 6 } });
    expect(split.record.dirs['app/leaf']).toBe('split');
    expect(whole.record.dirs['app/leaf']).toBe('whole');
    for (const r of [split, whole]) {
      expect(r.index.byPath.get('app/leaf/rules.py')).toBe('app/leaf');
      expect(r.index.byPath.get('app/leaf/limits.py')).toBe('app/leaf');
    }
  });

  it('ignores the record and reports partition_reset when thresholds change', () => {
    const changed = { ...TH, moduleMinSize: 1 };
    const r = partition({ ...base, thresholds: changed, record: first.record });
    expect(r.warnings.map((w) => [w.code, w.level])).toEqual([['partition_reset', 'info']]);
    expect(r.record.thresholds).toEqual(changed);
    expect(r.modules.map((m) => m.id)).toContain('app/tiny');
    expect(logLines.some((l) => l.includes('partition_reset'))).toBe(true);
  });

  it('keeps every assignment when only function bodies change, even if calls now point elsewhere', async () => {
    const edited = await indexShop({
      // tiny 改为调用 payments：第一次划分时会合并到 payments
      'app/tiny/one.py': 'from app.payments import service\n\n\ndef ping() -> None:\n    service.notify(0, "ping")\n',
      // a 不再调 b，b 改为调 c
      'app/big/a.py': readFileSync(path.join(FIXTURE, 'app/big/a.py'), 'utf8').replace('return b.b1() + 1', 'return 1'),
      'app/big/b.py': readFileSync(path.join(FIXTURE, 'app/big/b.py'), 'utf8').replace('from app.big import a', 'from app.big import c').replace('a.a2()', 'c.c2()'),
    });
    const fresh = partition({ ...edited, thresholds: TH });
    expect(fresh.index.byPath.get('app/tiny/one.py')).toBe('app/payments');
    expect(fresh.index.byPath.get('app/big/b.py')).not.toBe(fresh.index.byPath.get('app/big/a.py'));

    const kept = partition({ ...edited, thresholds: TH, record: first.record });
    expect(moduleFiles(kept)).toEqual(moduleFiles(first));
    expect(kept.recordChanged).toBe(false);
  }, 120_000);

  it('adds a new file only to its own module', async () => {
    const grown = await indexShop({
      'app/big/e.py': 'from app.big import d\n\n\ndef e1() -> int:\n    return d.d1()\n\n\ndef e2() -> int:\n    return 0\n',
    });
    const r = partition({ ...grown, thresholds: TH, record: first.record });
    const before = moduleFiles(first);
    const after = moduleFiles(r);
    expect(after['app/big#c']).toEqual([...before['app/big#c']!, 'app/big/e.py'].sort());
    expect({ ...after, 'app/big#c': [] }).toEqual({ ...before, 'app/big#c': [] });
    expect(r.record.clusters['app/big/e.py']).toBe('app/big#c');
    expect(r.record.sizes['app/big#c']).toBe(8);
  }, 120_000);
});

/** 合成输入：每个文件一个 module 符号加 n 个函数；边连在两个文件的第一个函数之间 */
function synth(sizes: Record<string, number>, calls: [string, string, EdgeRow['kind']?][] = []): Snapshot {
  const files: FileRow[] = [];
  const symbols: SymbolRow[] = [];
  const sym = (p: string, kind: string, i: number): SymbolRow => ({
    snapshotId: 1, id: `${p}:${kind}:${i}`, symbolKey: `${p}#${i}`, kind, name: `f${i}`, qualifiedName: `f${i}`, signature: '',
    displaySignature: '', parentId: null, path: p, startLine: i + 1, endLine: i + 1, bodyHash: '', normTokens: [], docstring: null,
    isTest: false, isGenerated: false, modelKind: null,
  });
  for (const [p, n] of Object.entries(sizes)) {
    files.push({ snapshotId: 1, path: p, language: 'python', supportLevel: 'full', contentHash: '', isTest: false, isGenerated: false });
    symbols.push(sym(p, 'module', 0));
    for (let i = 1; i <= n; i++) symbols.push(sym(p, 'function', i));
  }
  const first = (p: string) => symbols.find((s) => s.path === p && (sizes[p] === 0 || s.kind === 'function'))!.id;
  const edges: EdgeRow[] = calls.map(([a, b, kind]) => ({
    snapshotId: 1, srcId: first(a), dstId: first(b), kind: kind ?? 'call', provenance: 'scip', confidence: 'high', path: a, line: 1, col: 0,
  }));
  return { files, symbols, edges };
}

describe('partition record rules (synthetic)', () => {
  const th: PartitionThresholds = { moduleMinSize: 3, moduleMaxSize: 15, leafSplitSize: 100 };
  const run = (sizes: Record<string, number>, record?: PartitionRecord) => partition({ ...synth(sizes), thresholds: th, record });

  it('re-judges a directory once it grows past 2x the recorded size, also across several small steps', () => {
    const r1 = run({ 'pkg/a/x.py': 8, 'pkg/b/y.py': 20 });
    expect(r1.record.dirs['pkg/a']).toBe('whole');
    expect(r1.record.sizes['pkg/a']).toBe(8);
    // 1.875 倍：照记录，sizes 不变
    const r2 = run({ 'pkg/a/x.py': 15, 'pkg/b/y.py': 20 }, r1.record);
    expect(r2.record.sizes['pkg/a']).toBe(8);
    expect(r2.record.dirs['pkg/a']).toBe('whole');
    // 相对记录规模 8 累计 2.125 倍：重新判断，17 > moduleMaxSize 改为拆开，id 不变
    const r3 = run({ 'pkg/a/x.py': 17, 'pkg/b/y.py': 20 }, r2.record);
    expect(r3.record.dirs['pkg/a']).toBe('split');
    expect(r3.record.sizes['pkg/a']).toBe(17);
    expect(r3.index.byPath.get('pkg/a/x.py')).toBe('pkg/a');
    expect(logLines.some((l) => l.includes('partition_dir_rejudged') && l.includes('dir=pkg/a'))).toBe(true);
  });

  it('follows a split decision while the size stays within 0.5x of the record', () => {
    const r1 = run({ 'pkg/a/x.py': 8, 'pkg/b/y.py': 20 });
    expect(r1.record.dirs['pkg/b']).toBe('split');
    const r2 = run({ 'pkg/a/x.py': 8, 'pkg/b/y.py': 12 }, r1.record);
    expect(r2.record.dirs['pkg/b']).toBe('split');
    expect(r2.record.sizes['pkg/b']).toBe(20);
  });

  it('merges into <parent>/* without edges and keeps tiny modules alone when there is nothing to merge into', () => {
    const r = run({ 'pkg/main.py': 5, 'pkg/t/x.py': 1, 'pkg/big/y.py': 20, 'solo/z.py': 1 });
    expect(r.index.byPath.get('pkg/t/x.py')).toBe('pkg/*');
    expect(r.record.merges['pkg/t']).toBe('pkg/*');
    expect(r.index.byPath.get('solo/z.py')).toBe('solo');
  });

  it('re-clusters a split directory when a group outgrows 2x its recorded size', () => {
    const t: PartitionThresholds = { moduleMinSize: 1, moduleMaxSize: 10, leafSplitSize: 8 };
    const one = synth({ 'd/a.py': 3, 'd/b.py': 3, 'd/c.py': 3, 'd/e.py': 3 }, [['d/a.py', 'd/b.py'], ['d/c.py', 'd/e.py']]);
    const r1 = partition({ ...one, thresholds: t });
    expect(r1.modules.map((m) => m.id)).toEqual(['d#a', 'd#c']);
    const two = synth({ 'd/a.py': 3, 'd/b.py': 10, 'd/c.py': 3, 'd/e.py': 3 }, [['d/a.py', 'd/b.py'], ['d/c.py', 'd/e.py']]);
    const r2 = partition({ ...two, thresholds: t, record: r1.record });
    expect(r2.modules.map((m) => m.id)).toEqual(['d#a', 'd#b', 'd#c']);
    expect(r2.record.sizes['d#b']).toBe(10);
    expect(logLines.some((l) => l.includes('partition_dir_reclustered'))).toBe(true);
  });

  it('assigns an empty file in a split directory by import edges and records it', () => {
    const t: PartitionThresholds = { moduleMinSize: 1, moduleMaxSize: 10, leafSplitSize: 8 };
    const input = synth({ 'd/a.py': 3, 'd/b.py': 3, 'd/c.py': 6, 'd/e.py': 3, 'd/__init__.py': 0 },
      [['d/a.py', 'd/b.py'], ['d/c.py', 'd/e.py'], ['d/__init__.py', 'd/a.py', 'import']]);
    const r = partition({ ...input, thresholds: t });
    expect(r.index.byPath.get('d/__init__.py')).toBe('d#a');
    expect(r.record.clusters['d/__init__.py']).toBe('d#a');
  });
});

describe('partition record: split-by-file and keep-alone decisions (synthetic)', () => {
  const ids = (r: PartitionResult) => r.modules.map((m) => m.id);

  it('keeps the file groups when the direct files shrink just below leafSplitSize, and re-judges only past 0.5x', () => {
    const t: PartitionThresholds = { moduleMinSize: 1, moduleMaxSize: 6, leafSplitSize: 8 };
    const calls: [string, string][] = [['d/a.py', 'd/b.py']];
    const r1 = partition({ ...synth({ 'd/a.py': 3, 'd/b.py': 3, 'd/c.py': 3, 'd/sub/x.py': 7 }, calls), thresholds: t });
    expect(ids(r1)).toEqual(['d#a', 'd#c', 'd/sub']);
    expect(r1.record.direct?.['d']).toBe('clusters');

    const shrunk = synth({ 'd/a.py': 3, 'd/b.py': 3, 'd/c.py': 2, 'd/sub/x.py': 7 }, calls);
    expect(ids(partition({ ...shrunk, thresholds: t }))).toEqual(['d/*', 'd/sub']);
    const kept = partition({ ...shrunk, thresholds: t, record: r1.record });
    expect(ids(kept)).toEqual(['d#a', 'd#c', 'd/sub']);
    expect(kept.recordChanged).toBe(false);

    const small = partition({ ...synth({ 'd/a.py': 1, 'd/b.py': 1, 'd/c.py': 2, 'd/sub/x.py': 7 }, calls), thresholds: t, record: r1.record });
    expect(ids(small)).toEqual(['d/*', 'd/sub']);
    expect(small.record.direct?.['d']).toBe('files');
    expect(logLines.some((l) => l.includes('partition_direct_rejudged') && l.includes('dir=d '))).toBe(true);
  });

  it('names file groups of the root directory `#<group>` and keeps them with the record', () => {
    const t: PartitionThresholds = { moduleMinSize: 1, moduleMaxSize: 6, leafSplitSize: 8 };
    const input = synth({ 'a.py': 3, 'b.py': 3, 'c.py': 3, 'sub/x.py': 7 }, [['a.py', 'b.py']]);
    const r1 = partition({ ...input, thresholds: t });
    expect(ids(r1)).toEqual(['#a', '#c', 'sub']);
    expect(r1.record.clusters).toMatchObject({ 'a.py': '#a', 'b.py': '#a', 'c.py': '#c' });
    for (const m of r1.modules) expect(moduleDirs(m)).not.toContain('*');
    expect(moduleDirs(r1.modules[0]!)).toEqual(['.']);
    const again = partition({ ...input, thresholds: t, record: r1.record });
    expect(ids(again)).toEqual(['#a', '#c', 'sub']);
    expect(again.recordChanged).toBe(false);
  });

  it('keeps a module alone when it shrinks slightly below moduleMinSize, and re-decides past 0.5x', () => {
    const t: PartitionThresholds = { moduleMinSize: 3, moduleMaxSize: 15, leafSplitSize: 100 };
    const calls: [string, string][] = [['pkg/a/x.py', 'pkg/b/y.py']];
    const sizes = (a: number) => ({ 'pkg/a/x.py': a, 'pkg/b/y.py': 10, 'pkg/c/z.py': 20 });
    const r1 = partition({ ...synth(sizes(3), calls), thresholds: t });
    expect(ids(r1)).toEqual(['pkg/a', 'pkg/b', 'pkg/c']);
    expect(r1.record.merges['pkg/a']).toBeNull();
    expect(r1.record.mergeSizes?.['pkg/a']).toBe(3);

    expect(ids(partition({ ...synth(sizes(2), calls), thresholds: t }))).toEqual(['pkg/b', 'pkg/c']);
    const kept = partition({ ...synth(sizes(2), calls), thresholds: t, record: r1.record });
    expect(ids(kept)).toEqual(['pkg/a', 'pkg/b', 'pkg/c']);
    expect(kept.record.mergeSizes?.['pkg/a']).toBe(3);

    const merged = partition({ ...synth(sizes(1), calls), thresholds: t, record: r1.record });
    expect(merged.index.byPath.get('pkg/a/x.py')).toBe('pkg/b');
    expect(merged.record.merges['pkg/a']).toBe('pkg/b');
  });

  it('follows a recorded merge while the module stays within 2x moduleMinSize', () => {
    const t: PartitionThresholds = { moduleMinSize: 3, moduleMaxSize: 15, leafSplitSize: 100 };
    const calls: [string, string][] = [['pkg/t/x.py', 'pkg/b/y.py']];
    const sizes = (n: number) => ({ 'pkg/t/x.py': n, 'pkg/b/y.py': 10, 'pkg/c/z.py': 20 });
    const r1 = partition({ ...synth(sizes(1), calls), thresholds: t });
    expect(r1.record.merges['pkg/t']).toBe('pkg/b');
    // 规模 5 在 moduleMinSize 和 2 × moduleMinSize 之间：第一次判断会保持独立，照记录仍合并
    expect(ids(partition({ ...synth(sizes(5), calls), thresholds: t }))).toContain('pkg/t');
    const kept = partition({ ...synth(sizes(5), calls), thresholds: t, record: r1.record });
    expect(kept.index.byPath.get('pkg/t/x.py')).toBe('pkg/b');
    const grown = partition({ ...synth(sizes(7), calls), thresholds: t, record: kept.record });
    expect(grown.index.byPath.get('pkg/t/x.py')).toBe('pkg/t');
    expect(grown.record.merges['pkg/t']).toBeNull();
  });

  it('clusters a directory with thousands of files quickly', () => {
    const n = 3000;
    const name = (i: number) => `big/f${String(i).padStart(4, '0')}.py`;
    const sizes = Object.fromEntries(Array.from({ length: n }, (_, i) => [name(i), 2]));
    const calls: [string, string][] = [];
    for (let i = 0; i < n; i++) calls.push([name(i), name((i + 1) % n)], [name(i), name((i * 7 + 3) % n)]);
    const t: PartitionThresholds = { moduleMinSize: 1, moduleMaxSize: 40, leafSplitSize: 100 };
    const started = performance.now();
    const r = partition({ ...synth(sizes, calls), thresholds: t });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(r.modules.every((m) => m.kind === 'cluster' && m.size <= 40)).toBe(true);
    expect(r.modules.flatMap((m) => m.files)).toHaveLength(n);
  });
});

describe('partition record file', () => {
  it('writes through a temp file and reads it back; missing or broken files read as no record', async () => {
    const dataDir = tempDir('ci-partition-');
    expect(await readPartitionRecord(dataDir)).toBeUndefined();
    const r = partition({ ...synth({ 'a/x.py': 4 }), thresholds: DEFAULT_PARTITION_THRESHOLDS, now: 5 });
    await writePartitionRecord(dataDir, r.record);
    expect(await readPartitionRecord(dataDir)).toEqual(r.record);
    expect(existsSync(path.dirname(partitionRecordPath(dataDir)))).toBe(true);
    writeFileSync(partitionRecordPath(dataDir), '{"version": 99}');
    expect(await readPartitionRecord(dataDir)).toBeUndefined();
    writeFileSync(partitionRecordPath(dataDir), '{not json');
    expect(await readPartitionRecord(dataDir)).toBeUndefined();
  });

  it('logs and rethrows when the record cannot be written', async () => {
    const dataDir = tempDir('ci-partition-');
    writeFileSync(path.join(dataDir, 'overview'), 'not a directory');
    const r = partition({ ...synth({ 'a/x.py': 4 }), thresholds: DEFAULT_PARTITION_THRESHOLDS });
    await expect(writePartitionRecord(dataDir, r.record)).rejects.toThrow();
    expect(logLines.some((l) => l.includes('partition_record_write_failed'))).toBe(true);
  });
});
