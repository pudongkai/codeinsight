import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSnapshot, initDataDir, loadConfig, ScipPythonResolver, setLogSink, Store } from '../src/index.js';
import type { BuildSnapshotResult, DataDirLayout, EdgeRow, SymbolRow } from '../src/index.js';
import { commitAll, git, tempDir, writeFiles } from './helpers/git-repo.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'py-basic');

function fixtureRepo(): string {
  const repo = tempDir('ci-fixture-');
  cpSync(FIXTURE, repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  commitAll(repo, 'init');
  return repo;
}

interface Env {
  repo: string;
  store: Store;
  layout: DataDirLayout;
  build(opts?: { ref?: string; bin?: string }): Promise<BuildSnapshotResult>;
}

async function setup(repo: string): Promise<Env> {
  const config = await loadConfig(repo, { dataDir: tempDir('ci-data-') });
  const layout = await initDataDir(config.dataDir);
  const store = new Store(layout.dbPath);
  const build = (opts: { ref?: string; bin?: string } = {}) =>
    buildSnapshot({ repo, store, layout, config, ref: opts.ref, resolver: new ScipPythonResolver({ bin: opts.bin }) });
  return { repo, store, layout, build };
}

/** 把边转成 `kind src -> dst` 的可读形式 */
function describeEdges(store: Store, snapshotId: number): { edges: EdgeRow[]; text: string[]; syms: Map<string, SymbolRow> } {
  const syms = new Map(store.getSymbols(snapshotId).map((s) => [s.id, s]));
  const edges = store.getEdges(snapshotId);
  const text = edges.map((e) => `${e.kind} ${syms.get(e.srcId)!.qualifiedName} -> ${syms.get(e.dstId)!.qualifiedName}`);
  return { edges, text, syms };
}

let restoreSink: ((line: string) => void) | undefined;
const logLines: string[] = [];
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

describe('snapshot build with scip-python', () => {
  let env: Env;
  let result: BuildSnapshotResult;
  let text: string[];

  beforeAll(async () => {
    env = await setup(fixtureRepo());
    result = await env.build({ ref: 'HEAD' });
    text = describeEdges(env.store, result.snapshot.id).text;
  }, 120_000);

  it('marks extraction and resolution ok', () => {
    expect(result.snapshot).toMatchObject({ kind: 'commit', extractStatus: 'ok', resolverStatus: 'ok' });
    expect(result.cached).toBe(false);
    const stats = env.store.snapshotStats(result.snapshot.id);
    expect(stats.files).toBe(12);
    expect(stats.entries).toBe(15);
  });

  it('resolves calls through an aliased module import', () => {
    expect(text).toContain('call use -> f');
    expect(text).toContain('call Service.helper.<locals>.inner -> f');
  });

  it('distinguishes calls from references', () => {
    expect(text).toContain('call use -> g');
    expect(text).toContain('reference register -> g');
    expect(text).toContain('reference pkg.service -> f');
    expect(text).toContain('reference Service -> Base');
    expect(text).toContain('call Service.run -> Service.helper');
  });

  it('attributes top-level code and imports to the module symbol', () => {
    expect(text).toContain('call pkg.service -> f');
    expect(text).toContain('import pkg.service -> g');
    expect(text).toContain('import tests.test_repo -> pkg.repo');
  });

  it('keeps recursion and drops external symbols', () => {
    expect(text).toContain('call rec -> rec');
    const { edges, syms } = describeEdges(env.store, result.snapshot.id);
    for (const e of edges) expect(syms.has(e.dstId)).toBe(true);
    const fromUse = text.filter((t) => t.includes(' use -> '));
    expect(fromUse.sort()).toEqual(['call use -> f', 'call use -> g']);
  });

  it('does not treat the duplicate definition name as a reference, and binds references to the last definition', () => {
    expect(text.filter((t) => t.endsWith('-> dup'))).toEqual([]);
    expect(text).toContain('call use_dup -> dup#2');
  });

  it('has no edge from production code to test code', () => {
    const { edges, syms } = describeEdges(env.store, result.snapshot.id);
    expect(edges.filter((e) => !syms.get(e.srcId)!.isTest && syms.get(e.dstId)!.isTest)).toEqual([]);
    expect(text).toContain('call test_f -> f');
  });

  it('reuses the snapshot on the second build', async () => {
    const again = await env.build({ ref: 'HEAD' });
    expect(again.cached).toBe(true);
    expect(again.snapshot.id).toBe(result.snapshot.id);
    expect(logLines.some((l) => l.includes('snapshot_cache_hit'))).toBe(true);
  });
});

function failingBin(): string {
  const file = path.join(tempDir('ci-bin-'), 'fail.mjs');
  writeFileSync(file, 'console.error("boom from fake scip-python"); process.exit(3);\n');
  return file;
}

describe('snapshot build when scip-python fails', () => {
  it('stores extraction results and marks resolver_status=failed', async () => {
    const env = await setup(fixtureRepo());
    const result = await env.build({ ref: 'HEAD', bin: failingBin() });
    expect(result.snapshot.extractStatus).toBe('ok');
    expect(result.snapshot.resolverStatus).toBe('failed');
    expect(result.snapshot.resolverError).toContain('exited with code 3');
    expect(result.snapshot.resolverError).toContain('boom from fake scip-python');
    const stats = env.store.snapshotStats(result.snapshot.id);
    expect(stats).toMatchObject({ edges: 0, entries: 15 });
    expect(stats.symbols).toBeGreaterThan(30);
  });

  it('retries only the resolver on the next build, reusing the stored extraction', async () => {
    const env = await setup(fixtureRepo());
    const first = await env.build({ ref: 'HEAD', bin: failingBin() });
    const symbolsBefore = env.store.getSymbols(first.snapshot.id).map((s) => s.id).sort();
    const again = await env.build({ ref: 'HEAD', bin: failingBin() });
    expect(again).toMatchObject({ resolveRetried: true, snapshot: { resolverStatus: 'failed' } });

    const extractLogsBefore = logLines.filter((l) => l.includes('extract_done')).length;
    const exportLogsBefore = logLines.filter((l) => l.includes('snapshot_exported')).length;
    const retried = await env.build({ ref: 'HEAD' });
    expect(retried).toMatchObject({ cached: false, resolveRetried: true });
    expect(retried.snapshot).toMatchObject({ id: first.snapshot.id, extractStatus: 'ok', resolverStatus: 'ok', resolverError: null });
    expect(logLines.filter((l) => l.includes('extract_done')).length).toBe(extractLogsBefore);
    expect(logLines.filter((l) => l.includes('snapshot_exported')).length).toBe(exportLogsBefore);
    expect(env.store.getSymbols(first.snapshot.id).map((s) => s.id).sort()).toEqual(symbolsBefore);
    const text = describeEdges(env.store, first.snapshot.id).text;
    expect(text).toContain('call use -> f');
    expect(text).toContain('import tests.test_repo -> pkg.repo');

    const cached = await env.build({ ref: 'HEAD' });
    expect(cached).toMatchObject({ cached: true, resolveRetried: false });
  }, 120_000);
});

describe('working tree snapshot', () => {
  it('includes uncommitted and untracked files and excludes the in-repo data dir', async () => {
    const repo = fixtureRepo();
    writeFiles(repo, { 'pkg/extra.py': 'from .repo import g\n\n\ndef extra():\n    return g()\n' });
    const config = await loadConfig(repo);
    const layout = await initDataDir(config.dataDir);
    const store = new Store(layout.dbPath);
    const result = await buildSnapshot({ repo, store, layout, config });
    expect(result.snapshot.kind).toBe('working');
    const paths = store.getFiles(result.snapshot.id).map((f) => f.path);
    expect(paths).toContain('pkg/extra.py');
    expect(paths.some((p) => p.startsWith('.codeinsight/'))).toBe(false);
    expect(describeEdges(store, result.snapshot.id).text).toContain('call extra -> g');
    expect(git(repo, 'status', '--porcelain')).toBe('?? pkg/extra.py\n');
    store.close();
  }, 120_000);
});

describe('pyright project root', () => {
  async function buildWith(extra: Record<string, string>, committed: Record<string, string> = {}) {
    const repo = tempDir('ci-root-');
    git(repo, 'init', '-q', '-b', 'main');
    writeFiles(repo, { 'a.py': 'def f():\n    return 1\n', 'b.py': 'from a import f\n\n\ndef u():\n    return f()\n', ...committed });
    commitAll(repo, 'init');
    writeFiles(repo, extra);
    const config = await loadConfig(repo);
    const layout = await initDataDir(config.dataDir);
    const store = new Store(layout.dbPath);
    const result = await buildSnapshot({ repo, store, layout, config, ref: 'HEAD' });
    const out = { result, text: describeEdges(store, result.snapshot.id).text, files: store.getFiles(result.snapshot.id).map((f) => f.path), layout };
    store.close();
    return out;
  }

  it('uses the snapshot as project root when the repo has a pyproject.toml outside the snapshot', async () => {
    const { result, text, files } = await buildWith({ 'pyproject.toml': '[project]\nname = "x"\n' });
    expect(result.snapshot.resolverStatus).toBe('ok');
    expect(text).toContain('call u -> f');
    expect(files).not.toContain('pyrightconfig.json');
  }, 120_000);

  it('is not affected by a [tool.pyright] include in the repo above the snapshot', async () => {
    const { result, text } = await buildWith({ 'pyproject.toml': '[tool.pyright]\ninclude = ["nothing_here"]\n' });
    expect(result.snapshot.resolverStatus).toBe('ok');
    expect(text).toContain('call u -> f');
  }, 120_000);

  it('does not treat a parenthesized statement after a line-continued docstring as a call', async () => {
    const mod = ['def f():', '    return 1', '', '', 'DOC = """\\', 'text', '"""', 'handler = f', '(a, b) = (1,', '          2)', ''].join('\n');
    const { result, text } = await buildWith({}, { 'c.py': mod });
    expect(result.snapshot.resolverStatus).toBe('ok');
    expect(text).toContain('reference c -> f');
    expect(text).not.toContain('call c -> f');
  }, 120_000);

  it('keeps the project configuration that the snapshot already has', async () => {
    const cfg = '{ "exclude": ["build"] }\n';
    const { result, text, layout } = await buildWith({}, { 'pyrightconfig.json': cfg });
    expect(text).toContain('call u -> f');
    expect(readFileSync(path.join(layout.snapshotsDir, result.snapshot.contentKey, 'pyrightconfig.json'), 'utf8')).toBe(cfg);
  }, 120_000);
});

describe('concurrent builds of the same snapshot', () => {
  it('reuses the result of the build it waited for, even when resolution failed', async () => {
    const env = await setup(fixtureRepo());
    const counter = path.join(tempDir('ci-count-'), 'runs');
    const bin = path.join(tempDir('ci-bin-'), 'slow-fail.mjs');
    writeFileSync(bin, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(counter)}, 'x');\nawait new Promise((r) => setTimeout(r, 300));\nprocess.exit(2);\n`);
    const [a, b] = await Promise.all([env.build({ ref: 'HEAD', bin }), env.build({ ref: 'HEAD', bin })]);
    expect(readFileSync(counter, 'utf8')).toBe('x');
    expect([a.cached, b.cached].sort()).toEqual([false, true]);
    expect(a.snapshot.resolverStatus).toBe('failed');
    expect(b.snapshot.resolverStatus).toBe('failed');
  }, 120_000);
});
