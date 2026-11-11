import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSnapshot, callerSummaries, initDataDir, loadGraphSide, loadConfig, runReview, setLogSink, Store } from '../src/index.js';
import type { ReviewReport, SymbolRow } from '../src/index.js';
import { git, tempDir } from './helpers/git-repo.js';

const CLAUVE = process.env.CODEINSIGHT_CLAUVE?.replace(/^~(?=$|\/)/, os.homedir());
const COMMIT = '80cf8e1';

interface Callers {
  prod: number;
  test: number;
}

/** 调用方按不同的调用函数计数 */
function callers(store: Store, snapshotId: number, target: SymbolRow, syms: Map<string, SymbolRow>): Callers {
  const srcIds = new Set(store.getEdgesForSymbols(snapshotId, [target.id], 'in', ['call']).map((e) => e.srcId));
  const srcs = [...srcIds].map((id) => syms.get(id)!);
  return { prod: srcs.filter((s) => !s.isTest).length, test: srcs.filter((s) => s.isTest).length };
}

describe.skipIf(!CLAUVE)('clauve integration (CODEINSIGHT_CLAUVE)', () => {
  it(`matches the verified caller counts at ${COMMIT}`, async () => {
    const repo = path.resolve(CLAUVE!);
    const statusBefore = git(repo, 'status', '--porcelain');
    const config = await loadConfig(repo, { dataDir: tempDir('ci-clauve-') });
    const layout = await initDataDir(config.dataDir);
    const store = new Store(layout.dbPath);
    try {
      const { snapshot } = await buildSnapshot({ repo, store, layout, config, ref: COMMIT });
      expect(snapshot).toMatchObject({ kind: 'commit', extractStatus: 'ok', resolverStatus: 'ok' });
      const syms = new Map(store.getSymbols(snapshot.id).map((s) => [s.id, s]));

      const audit = store.findSymbolsByName(snapshot.id, 'insert_audit_log').filter((s) => s.path === 'server/modules/lease/repository.py');
      expect(audit).toHaveLength(1);
      expect(callers(store, snapshot.id, audit[0]!, syms)).toEqual({ prod: 7, test: 0 });
      // 审查报告用的同一份调用方统计
      const side = loadGraphSide(store, snapshot);

      const release = store.findSymbolsByName(snapshot.id, 'select_release_by_version');
      expect(release).toHaveLength(1);
      expect(callers(store, snapshot.id, release[0]!, syms)).toEqual({ prod: 14, test: 16 });
      const summaries = callerSummaries(side, [audit[0]!.id, release[0]!.id]);
      expect(summaries.get(audit[0]!.id)).toMatchObject({ prod: 7, test: 0 });
      expect(summaries.get(release[0]!.id)).toMatchObject({ prod: 14, test: 16 });

      const prodToTest = store.getEdges(snapshot.id).filter((e) => !syms.get(e.srcId)!.isTest && syms.get(e.dstId)!.isTest);
      expect(prodToTest).toEqual([]);
    } finally {
      store.close();
    }
    expect(git(repo, 'status', '--porcelain')).toBe(statusBefore);
  }, 600_000);
});

const ADMIN_API = 'server/console/modules/console/admin_api.py';

describe.skipIf(!CLAUVE)('clauve review fc4c752 (CODEINSIGHT_CLAUVE)', () => {
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

  it('lists the 16 added admin_api.py functions, flags non-Python files, and reuses snapshots on the second review', async () => {
    const repo = path.resolve(CLAUVE!);
    const statusBefore = git(repo, 'status', '--porcelain');
    const config = await loadConfig(repo, { dataDir: tempDir('ci-clauve-review-') });
    const layout = await initDataDir(config.dataDir);
    const review = async (): Promise<ReviewReport> => {
      const store = new Store(layout.dbPath);
      try {
        return await runReview({ repo, store, layout, config, base: 'fc4c752~1', head: 'fc4c752' });
      } finally {
        store.close();
      }
    };

    const report = await review();
    expect(report.warnings.filter((w) => w.code === 'resolver_failed')).toEqual([]);
    const admin = report.modules.flatMap((m) => m.symbols).filter((s) => s.path === ADMIN_API);
    expect(admin.filter((s) => s.change === 'added' && s.kind === 'function')).toHaveLength(16);

    const nonPython = report.files.filter((f) => !/\.pyi?$/.test(f.path));
    expect(nonPython.length).toBeGreaterThan(0);
    const flagged = new Set(report.warnings.filter((w) => w.code === 'language_unsupported').map((w) => w.path));
    for (const f of nonPython) {
      expect(f.supportLevel).toBe('none');
      expect(flagged.has(f.path)).toBe(true);
    }

    const before = logLines.length;
    const again = await review();
    const secondLogs = logLines.slice(before);
    expect(secondLogs.filter((l) => l.includes('snapshot_cache_hit'))).toHaveLength(2);
    expect(secondLogs.filter((l) => l.includes('scip_python_start'))).toEqual([]);
    expect(again.modules).toEqual(report.modules);
    expect(git(repo, 'status', '--porcelain')).toBe(statusBefore);
  }, 900_000);
});
