import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSnapshot, initDataDir, loadConfig, Store } from '../src/index.js';
import type { SymbolRow } from '../src/index.js';
import { git, tempDir } from './helpers/git-repo.js';

const CLAUVE = process.env.CODEINSIGHT_CLAUVE?.replace(/^~(?=$|\/)/, os.homedir());
const COMMIT = '80cf8e1';

interface Callers {
  prod: number;
  test: number;
}

/** 调用方按不同的调用函数计数 */
function callers(store: Store, snapshotId: number, target: SymbolRow, syms: Map<string, SymbolRow>): Callers {
  const srcIds = new Set(store.getEdgesTo(snapshotId, target.id).filter((e) => e.kind === 'call').map((e) => e.srcId));
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

      const release = store.findSymbolsByName(snapshot.id, 'select_release_by_version');
      expect(release).toHaveLength(1);
      expect(callers(store, snapshot.id, release[0]!, syms)).toEqual({ prod: 14, test: 16 });

      const prodToTest = store.getEdges(snapshot.id).filter((e) => !syms.get(e.srcId)!.isTest && syms.get(e.dstId)!.isTest);
      expect(prodToTest).toEqual([]);
    } finally {
      store.close();
    }
    expect(git(repo, 'status', '--porcelain')).toBe(statusBefore);
  }, 600_000);
});
