import { chmodSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSnapshot, initDataDir, loadConfig, sha1, Store } from '../src/index.js';
import type { BuildSnapshotResult, EdgeRow, Resolver, SymbolRow } from '../src/index.js';
import { setLogSink } from '../src/log.js';
import { GoResolver } from '../src/resolve/go.js';
import { LanguageResolver } from '../src/resolve/language-resolver.js';
import { FAILED_RERESOLVE_AFTER_MS, mayNeedReresolve } from '../src/resolve/edge-sources.js';
import { goContinuedLines } from '../src/resolve/scip-rules-go.js';
import { goListError, runScipGo, ScipRunError } from '../src/scip/runner.js';
import { goScipPath, snapshotDir } from '../src/store/data-dir.js';
import { findCommand } from '../src/util/command.js';
import { commitAll, git, tempDir } from './helpers/git-repo.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'go-basic');
const PKG = 'example.com/gobasic/internal/order';
const HAS_SCIP_GO = findCommand('scip-go', { extraDirs: [path.join(process.env.HOME ?? '', 'go', 'bin')], noCache: true }).ok;

function fixtureRepo(): string {
  const repo = tempDir('ci-go-resolve-');
  cpSync(FIXTURE, repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  commitAll(repo, 'init');
  return repo;
}

async function setup(resolver: () => Resolver) {
  const repo = fixtureRepo();
  const config = await loadConfig(repo, { dataDir: tempDir('ci-go-resolve-data-') });
  const layout = await initDataDir(config.dataDir);
  const store = new Store(layout.dbPath);
  const build = (): Promise<BuildSnapshotResult> => buildSnapshot({ repo, store, layout, config, resolver: resolver() });
  return { repo, store, layout, build };
}

function describeEdges(edges: EdgeRow[], symbols: SymbolRow[]): string[] {
  const qn = new Map(symbols.map((s) => [s.id, `${s.path}#${s.qualifiedName}`]));
  return edges.map((e) => `${e.kind} ${qn.get(e.srcId)} -> ${qn.get(e.dstId)}`);
}

const goOnly = (scip: boolean): Resolver => new LanguageResolver({ go: new GoResolver({ scip }) });

describe('Go resolver with name matching', () => {
  it('stores name-match call and import edges, and a retried resolve yields the same edges', async () => {
    const env = await setup(() => goOnly(false));
    const first = await env.build();
    expect(first.snapshot).toMatchObject({ resolverStatus: 'ok' });
    expect(first.snapshot.edgeSources?.go).toMatchObject({ source: 'name_match', reason: 'disabled' });
    const edges = env.store.getEdges(first.snapshot.id);
    const text = describeEdges(edges, env.store.getSymbols(first.snapshot.id));
    expect(text).toContain(`call backend/cmd/server/main.go#example.com/gobasic/cmd/server.main -> backend/internal/order/service.go#${PKG}.NewService`);
    expect(text).toContain(`call backend/internal/order/service.go#${PKG}.Service.Get -> backend/internal/order/repo.go#${PKG}.Repo.Find`);
    expect(text).toContain(`import backend/cmd/server/main.go#example.com/gobasic/cmd/server/main.go -> backend/internal/order/doc.go#${PKG}/doc.go`);
    expect(edges.every((e) => e.provenance === 'name_match')).toBe(true);

    env.store.setSnapshotStatus(first.snapshot.id, { resolverStatus: 'failed', resolverError: 'boom' });
    const retried = await env.build();
    expect(retried.resolveRetried).toBe(true);
    expect(env.store.getEdges(retried.snapshot.id)).toHaveLength(edges.length);
  }, 120_000);
});

describe('Go resolver needsReresolve', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env.CODEINSIGHT_SCIP_GO = saved.CODEINSIGHT_SCIP_GO;
    if (saved.CODEINSIGHT_SCIP_GO === undefined) delete process.env.CODEINSIGHT_SCIP_GO;
  });

  async function prepared(scipGo: string): Promise<GoResolver> {
    process.env.CODEINSIGHT_SCIP_GO = scipGo;
    const r = new GoResolver();
    await r.prepare();
    return r;
  }

  function fakeScipGo(): string {
    const bin = path.join(tempDir('ci-fake-scip-go-'), 'scip-go');
    writeFileSync(bin, '#!/bin/sh\necho 9.9.9\n');
    chmodSync(bin, 0o755);
    return bin;
  }

  it('re-resolves a not_found fallback once scip-go is found, and not while it is still missing', async () => {
    const sources = { go: { source: 'name_match' as const, reason: 'not_found' as const, at: Date.now() } };
    const found = await prepared(fakeScipGo());
    expect(found.version).toMatch(/^scip-go@9\.9\.9:/);
    expect(await found.needsReresolve(sources)).toBe(true);
    const absent = await prepared('/nonexistent/scip-go');
    expect(absent.version).toMatch(/^name-match:/);
    expect(await absent.needsReresolve(sources)).toBe(false);
  });

  it('re-resolves a failed fallback only after the retry interval', async () => {
    const r = await prepared(fakeScipGo());
    const now = Date.now();
    const failedAt = (at: number) => ({ go: { source: 'name_match' as const, reason: 'failed' as const, at } });
    expect(await r.needsReresolve(failedAt(now - FAILED_RERESOLVE_AFTER_MS - 1), now)).toBe(true);
    expect(await r.needsReresolve(failedAt(now - 1000), now)).toBe(false);
  });

  it('keeps disabled, no_module and scip results', async () => {
    const r = await prepared(fakeScipGo());
    expect(await r.needsReresolve({ go: { source: 'name_match', reason: 'disabled', at: 0 } })).toBe(false);
    expect(await r.needsReresolve({ go: { source: 'scip' } })).toBe(false);
    expect(await r.needsReresolve({ go: { source: 'name_match', reason: 'no_module', at: 0 } })).toBe(false);
    expect(mayNeedReresolve({ go: { source: 'name_match', reason: 'no_module', at: 0 } })).toBe(false);
    const off = new GoResolver({ scip: false });
    await off.prepare();
    expect(await off.needsReresolve({ go: { source: 'name_match', reason: 'not_found', at: 0 } })).toBe(false);
  });
});

describe('Go SCIP helpers', () => {
  it('tracks open brackets across lines, ignoring strings and comments', () => {
    const src = 'f(a,\n  "(", `\n)`, // (\n  b) /* ( */\nx := 1';
    expect(goContinuedLines(src)).toEqual([true, true, true, false, false]);
  });

  it('reports the first package load error from go list output', () => {
    expect(goListError('{\n\t"ImportPath": "a"\n}\n')).toBeUndefined();
    const out = '{\n\t"ImportPath": "a",\n\t"DepsErrors": [\n\t\t{\n\t\t\t"Err": "no required module provides package x/y"\n\t\t}\n\t]\n}\n';
    expect(goListError(out)).toBe('no required module provides package x/y');
  });

  it('ends the scip-go process group on abort', async () => {
    const dir = tempDir('ci-fake-go-');
    const pidFile = path.join(dir, 'grandchild.pid');
    const fake = path.join(dir, 'fake.sh');
    writeFileSync(fake, `#!/bin/sh\nif [ "$1" = list ]; then exit 0; fi\nsleep 300 &\necho $! > ${pidFile}\nwait\n`);
    chmodSync(fake, 0o755);
    const controller = new AbortController();
    const running = runScipGo({ bin: fake, goBin: fake, moduleDir: dir, output: path.join(dir, 'out.scip'), env: process.env, timeoutMs: 60_000, signal: controller.signal });
    while (!existsSync(pidFile) || !readFileSync(pidFile, 'utf8').trim()) await new Promise((r) => setTimeout(r, 20));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(ScipRunError);
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 30_000);
});

describe.skipIf(!HAS_SCIP_GO)('Go resolver with scip-go', () => {
  it('builds scip edges for a go.mod in a subdirectory without changing go.mod', async () => {
    const lines: string[] = [];
    const prevSink = setLogSink((l) => lines.push(l));
    let env: Awaited<ReturnType<typeof setup>>;
    let result: BuildSnapshotResult;
    try {
      env = await setup(() => goOnly(true));
      result = await env.build();
    } finally {
      setLogSink(prevSink);
    }
    const snap = result.snapshot;
    expect(snap).toMatchObject({ resolverStatus: 'ok', resolverError: null });
    expect(snap.edgeSources?.go).toEqual({ source: 'scip' });
    expect(existsSync(goScipPath(env.layout, snap.contentKey))).toBe(true);
    const edges = env.store.getEdges(snap.id);
    const text = describeEdges(edges, env.store.getSymbols(snap.id));
    expect(text).toContain(`call backend/cmd/server/main.go#example.com/gobasic/cmd/server.main.func1 -> backend/internal/order/service.go#${PKG}.Service.Create`);
    expect(text).toContain(`call backend/internal/order/service.go#${PKG}.Service.Get -> backend/internal/order/repo.go#${PKG}.Repo.Find`);
    expect(text).toContain(`import backend/cmd/server/main.go#example.com/gobasic/cmd/server/main.go -> backend/internal/order/doc.go#${PKG}/doc.go`);
    expect(edges.every((e) => e.provenance === 'scip')).toBe(true);
    const dir = snapshotDir(env.layout, snap.contentKey);
    expect(sha1(readFileSync(path.join(dir, 'backend/go.mod')))).toBe(sha1(readFileSync(path.join(FIXTURE, 'backend/go.mod'))));
    expect(existsSync(path.join(dir, 'backend/go.sum'))).toBe(false);
    const stats = lines.find((l) => l.includes('go_edges') && l.includes('source=scip'));
    // 记录对上的定义比例，便于验证
    console.log(stats);
    expect(stats).toMatch(/definitions=(\d+) matchedByPosition=\1\b/);
  }, 120_000);
});
