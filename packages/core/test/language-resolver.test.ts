import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildSnapshot, initDataDir, LanguageResolver, loadConfig, setLogSink, snapshotDir, Store,
} from '../src/index.js';
import type {
  BuildSnapshotResult, CodeInsightConfig, DataDirLayout, EdgeRow, EdgeSources, ExtractedFile, ExtractedSymbol, Language,
  ResolveInput, ResolveResult, Resolver,
} from '../src/index.js';
import { initRepo, tempDir, writeFiles } from './helpers/git-repo.js';

/** 每个文件生成一条 module → 第一个定义的调用边 */
function moduleCallEdges(input: ResolveInput): EdgeRow[] {
  return input.files.flatMap((f) => {
    const [mod, first] = f.symbols;
    if (!mod || !first) return [];
    return [{ snapshotId: input.snapshotId, srcId: mod.id, dstId: first.id, kind: 'call', provenance: 'scip', confidence: 'high', path: f.path, line: 1, col: 0 }];
  });
}

/** 假的子解析器：记录调用，按设定返回边来源、生效版本或抛错 */
class FakeResolver implements Resolver {
  calls = 0;
  prepared: Language[][] = [];
  files: string[] = [];
  source?: EdgeSources;
  effectiveVersion?: string;
  error?: string;
  reresolve = false;
  reresolveAsked = 0;

  constructor(readonly name: string, public version: string) {}

  prepare(languages: Language[]): Promise<void> {
    this.prepared.push(languages);
    return Promise.resolve();
  }

  resolve(input: ResolveInput): Promise<ResolveResult> {
    this.calls++;
    this.files.push(...input.files.map((f) => f.path));
    if (this.error) return Promise.reject(new Error(this.error));
    return Promise.resolve({ edges: moduleCallEdges(input), sources: this.source, effectiveVersion: this.effectiveVersion });
  }

  needsReresolve(): Promise<boolean> {
    this.reresolveAsked++;
    return Promise.resolve(this.reresolve);
  }
}

function sym(file: string, id: string, kind: ExtractedSymbol['kind']): ExtractedSymbol {
  return {
    id, symbolKey: `${file}#${kind}#${id}#`, kind, name: id, qualifiedName: id, signature: '', displaySignature: '',
    parentId: null, path: file, startLine: 1, endLine: 2, bodyHash: '', normTokens: [], docstring: null,
    isTest: false, isGenerated: false, modelKind: null, nameLine: 0, nameCol: 0,
  };
}

function file(p: string, language: Language): ExtractedFile {
  return { path: p, language, symbols: [sym(p, `${p}:m`, 'module'), sym(p, `${p}:f`, 'function')], entries: [], importRows: [], imports: new Map() };
}

function input(files: ExtractedFile[], signal?: AbortSignal): ResolveInput {
  return { snapshotId: 1, contentKey: 'k', root: '/nonexistent', layout: {} as DataDirLayout, files, timeoutMs: 1000, signal };
}

describe('LanguageResolver', () => {
  it('runs only the languages present and builds its version from them', async () => {
    const py = new FakeResolver('py', 'p1');
    const go = new FakeResolver('go', 'g1');
    const r = new LanguageResolver({ python: py, go });
    await r.prepare(['python', 'python', 'java']);
    expect(py.prepared).toEqual([['python']]);
    expect(go.prepared).toEqual([]);
    expect(r.version).toBe('python=p1');
    go.version = 'g2';
    expect(r.version).toBe('python=p1');

    const result = await r.resolve(input([file('a.py', 'python'), file('b.java', 'java')]));
    expect(py.files).toEqual(['a.py']);
    expect(go.calls).toBe(0);
    expect(result).toMatchObject({ sources: { python: { source: 'scip' } }, effectiveVersion: 'python=p1' });
    expect(result.edges).toHaveLength(1);
    expect(result.failed).toBeUndefined();

    await r.prepare(['go', 'python']);
    expect(r.version).toBe('go=g2;python=p1');
  });

  it('keeps the other languages\' edges when one language fails, and throws when aborted', async () => {
    const py = new FakeResolver('py', 'p1');
    const go = new FakeResolver('go', 'g1');
    go.error = 'scip-go exploded\nstack';
    const r = new LanguageResolver({ python: py, go });
    await r.prepare(['python', 'go']);
    const files = [file('a.py', 'python'), file('b.go', 'go')];
    const result = await r.resolve(input(files));
    expect(result.edges.map((e) => e.path)).toEqual(['a.py']);
    expect(result.failed).toEqual([{ language: 'go', reason: 'scip-go exploded\nstack' }]);
    expect(result.sources).toMatchObject({ python: { source: 'scip' }, go: { source: 'failed', note: 'scip-go exploded' } });

    const controller = new AbortController();
    controller.abort();
    await expect(r.resolve(input(files, controller.signal))).rejects.toThrow('scip-go exploded');
  });

  it('reports the effective version and the sources returned by sub-resolvers', async () => {
    const py = new FakeResolver('py', 'p1');
    const go = new FakeResolver('go', 'scip-go@1');
    go.source = { go: { source: 'name_match', reason: 'not_found', at: 1 } };
    go.effectiveVersion = 'name-match';
    const r = new LanguageResolver({ python: py, go });
    await r.prepare(['python', 'go']);
    const result = await r.resolve(input([file('a.py', 'python'), file('b.go', 'go')]));
    expect(result.effectiveVersion).toBe('go=name-match;python=p1');
    expect(result.sources).toEqual({ go: { source: 'name_match', reason: 'not_found', at: 1 }, python: { source: 'scip' } });
  });

  it('asks only the sub-resolvers of the recorded languages whether to resolve again', async () => {
    const py = new FakeResolver('py', 'p1');
    const go = new FakeResolver('go', 'g1');
    const r = new LanguageResolver({ python: py, go });
    go.reresolve = true;
    expect(await r.needsReresolve({ python: { source: 'scip' } })).toBe(false);
    expect(go.reresolveAsked).toBe(0);
    expect(await r.needsReresolve({ python: { source: 'scip' }, go: { source: 'name_match', reason: 'not_found' } })).toBe(true);
  });
});

// ---- 快照流水线 ----

const logLines: string[] = [];
let restoreSink: ((line: string) => void) | undefined;
const logLevel = process.env.CODEINSIGHT_LOG;
beforeAll(() => {
  process.env.CODEINSIGHT_LOG = 'info';
  restoreSink = setLogSink((line) => logLines.push(line));
});
afterAll(() => {
  if (restoreSink) setLogSink(restoreSink);
  if (logLevel === undefined) delete process.env.CODEINSIGHT_LOG;
  else process.env.CODEINSIGHT_LOG = logLevel;
});

interface Env {
  repo: string;
  store: Store;
  layout: DataDirLayout;
  config: CodeInsightConfig;
  build(resolver: Resolver): Promise<BuildSnapshotResult>;
}

async function setup(): Promise<Env> {
  const repo = initRepo({ 'a.py': 'def f():\n    return 1\n', 'b.py': 'def g():\n    return 2\n', 'README.md': '# r\n' });
  const config = await loadConfig(repo, { dataDir: tempDir('ci-langres-data-'), env: {} });
  const layout = await initDataDir(config.dataDir);
  const store = new Store(layout.dbPath);
  return { repo, store, layout, config, build: (resolver) => buildSnapshot({ repo, store, layout, config, resolver }) };
}

/** 直接返回给定结果的解析器，用来测试入库规则 */
class FixedResolver implements Resolver {
  readonly name = 'fixed';
  readonly version = 'v1';
  constructor(private readonly make: (input: ResolveInput) => ResolveResult) {}
  resolve(i: ResolveInput): Promise<ResolveResult> {
    return Promise.resolve(this.make(i));
  }
}

describe('snapshot pipeline with per-language resolution', () => {
  it('stores the edges of the languages that succeeded and marks the snapshot failed when one language failed', async () => {
    const env = await setup();
    const partial = new FixedResolver((i) => ({
      edges: moduleCallEdges(i),
      sources: { python: { source: 'scip' }, go: { source: 'failed', note: 'boom' } },
      failed: [{ language: 'go', reason: 'boom\ndetail' }],
    }));
    const first = await env.build(partial);
    expect(first.snapshot).toMatchObject({
      resolverStatus: 'failed', resolverError: 'go: boom\ndetail',
      edgeSources: { python: { source: 'scip' }, go: { source: 'failed', note: 'boom' } },
    });
    expect(env.store.getEdges(first.snapshot.id)).toHaveLength(2);
    expect(env.store.getEdgesCodeHash(first.snapshot.id)).toBeUndefined();
    expect(logLines.some((l) => l.includes(' resolve_partial_failed ') && l.includes('languages=go'))).toBe(true);

    // 下次重跑解析
    const ok = new FakeResolver('py', 'p1');
    const again = await env.build(new LanguageResolver({ python: ok }));
    expect(again).toMatchObject({ resolveRetried: true, snapshot: { resolverStatus: 'ok', resolverError: null, edgeSources: { python: { source: 'scip' } } } });
    expect(env.store.getEdgesCodeHash(again.snapshot.id)).toBeDefined();
    env.store.close();
  }, 60_000);

  it('does not write the edges code hash when a language fell back to name matching because its tool failed', async () => {
    const env = await setup();
    const fellBack = new FixedResolver((i) => ({
      edges: moduleCallEdges(i), sources: { python: { source: 'name_match', reason: 'failed', at: Date.now() } },
    }));
    const { snapshot } = await env.build(fellBack);
    expect(snapshot.resolverStatus).toBe('ok');
    expect(env.store.getEdgesCodeHash(snapshot.id)).toBeUndefined();
    env.store.close();
  }, 60_000);

  it('copies edge sources together with reused edges, using the effective version for the code hash', async () => {
    const env = await setup();
    const py = new FakeResolver('py', 'name-match');
    py.source = { python: { source: 'name_match', reason: 'not_found', at: 42 } };
    py.effectiveVersion = 'name-match';
    const first = await env.build(new LanguageResolver({ python: py }));
    expect(first.snapshot.edgeSources).toEqual({ python: { source: 'name_match', reason: 'not_found', at: 42 } });

    writeFiles(env.repo, { 'README.md': '# changed\n' });
    const second = await env.build(new LanguageResolver({ python: py }));
    expect(py.calls).toBe(1);
    expect(second.snapshot.id).not.toBe(first.snapshot.id);
    expect(second.snapshot.edgeSources).toEqual(first.snapshot.edgeSources);
    expect(env.store.getEdges(second.snapshot.id)).toHaveLength(2);
    expect(logLines.some((l) => l.includes(' resolve_reused ') && l.includes(first.snapshot.contentKey))).toBe(true);
    env.store.close();
  }, 60_000);

  it('resolves again through retryResolve when the resolver asks for it, without rebuilding the snapshot directory', async () => {
    const env = await setup();
    const py = new FakeResolver('py', 'p1');
    py.source = { python: { source: 'name_match', reason: 'not_found', at: 1 } };
    const first = await env.build(new LanguageResolver({ python: py }));
    const dir = snapshotDir(env.layout, first.snapshot.contentKey);
    const before = statSync(path.join(dir, 'a.py')).ino;

    // 解析器认为不需要：直接复用
    const kept = await env.build(new LanguageResolver({ python: py }));
    expect(kept).toMatchObject({ cached: true, resolveRetried: false });
    expect(py.reresolveAsked).toBe(1);
    expect(py.calls).toBe(1);

    py.reresolve = true;
    py.source = undefined;
    const again = await env.build(new LanguageResolver({ python: py }));
    expect(again).toMatchObject({ cached: false, resolveRetried: true, snapshot: { id: first.snapshot.id, resolverStatus: 'ok', edgeSources: { python: { source: 'scip' } } } });
    expect(py.calls).toBe(2);
    expect(py.prepared.at(-1)).toEqual(['python']);
    expect(statSync(path.join(dir, 'a.py')).ino).toBe(before);
    expect(logLines.some((l) => l.includes(' reresolve_check ') && l.includes('needed=true'))).toBe(true);

    // 边都来自 scip 后走持锁前的快速复用，不再询问
    const fast = await env.build(new LanguageResolver({ python: py }));
    expect(fast).toMatchObject({ cached: true });
    expect(py.reresolveAsked).toBe(2);
    env.store.close();
  }, 60_000);
});

describe('edge_sources column', () => {
  it('is added to the snapshots table of an existing database on open', async () => {
    const layout = await initDataDir(tempDir('ci-langres-old-'));
    const store = new Store(layout.dbPath);
    const snap = store.createSnapshot('working', 'abc', 'key-1');
    store.close();
    const raw = new DatabaseSync(layout.dbPath);
    raw.exec('ALTER TABLE snapshots DROP COLUMN edge_sources');
    raw.close();

    const reopened = new Store(layout.dbPath);
    expect(reopened.rebuilt).toBe(false);
    const cols = (reopened.db.prepare('PRAGMA table_info(snapshots)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('edge_sources');
    expect(reopened.getSnapshot(snap.id)?.edgeSources).toBeNull();
    reopened.setEdgeSources(snap.id, { python: { source: 'scip' } });
    expect(reopened.getSnapshot(snap.id)?.edgeSources).toEqual({ python: { source: 'scip' } });
    expect(existsSync(layout.dbPath)).toBe(true);
    expect(logLines.some((l) => l.includes(' index_db_columns_added ') && l.includes('snapshots.edge_sources'))).toBe(true);
    reopened.close();
  });
});
