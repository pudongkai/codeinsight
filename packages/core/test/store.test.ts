import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, Store, symbolIdFromKey } from '../src/index.js';
import type { SymbolRow } from '../src/index.js';
import { tempDir } from './helpers/git-repo.js';

function sampleSymbol(snapshotId: number, key: string): SymbolRow {
  return {
    snapshotId, id: symbolIdFromKey(key), symbolKey: key, kind: 'function', name: 'f', qualifiedName: 'f',
    signature: '', displaySignature: '(a, b=1)', parentId: null, path: 'a.py', startLine: 1, endLine: 3,
    bodyHash: 'h', normTokens: ['def', 'ID', '(', 'ID', ')'], docstring: 'doc', isTest: false, isGenerated: false,
  };
}

describe('store', () => {
  it('creates schema and round-trips all entities', () => {
    const store = new Store(path.join(tempDir(), 'index.db'));
    expect(store.rebuilt).toBe(true);
    const snap = store.createSnapshot('commit', 'abc', 'abc');
    expect(snap.extractStatus).toBe('pending');
    store.setSnapshotStatus(snap.id, { extractStatus: 'ok', resolverStatus: 'failed', resolverError: 'boom' });
    expect(store.getSnapshot(snap.id)).toMatchObject({ extractStatus: 'ok', resolverStatus: 'failed', resolverError: 'boom' });

    store.insertFiles([{ snapshotId: snap.id, path: 'a.py', language: 'python', supportLevel: 'full', contentHash: 'c', isTest: false, isGenerated: false }]);
    const s1 = sampleSymbol(snap.id, 'a.py#function#f#');
    const s2 = { ...sampleSymbol(snap.id, 'a.py#function#g#'), name: 'g', qualifiedName: 'g' };
    store.insertSymbols([s1, s2]);
    store.insertEdges([{ snapshotId: snap.id, srcId: s2.id, dstId: s1.id, kind: 'call', provenance: 'scip', confidence: 'high', path: 'a.py', line: 5, col: 4 }]);
    store.insertEntries([{ snapshotId: snap.id, symbolId: s1.id, kind: 'http', framework: 'fastapi', detail: { method: 'GET', path: '/x' } }]);

    expect(store.getFiles(snap.id)).toHaveLength(1);
    expect(store.getSymbol(snap.id, s1.id)).toEqual(s1);
    expect(store.getEdgesForSymbols(snap.id, [s1.id], 'in')).toHaveLength(1);
    expect(store.getEdgesForSymbols(snap.id, [s2.id], 'out')[0]!.line).toBe(5);
    expect(store.getEntries(snap.id)[0]!.detail).toEqual({ method: 'GET', path: '/x' });

    const rid = store.createReview({ working: true });
    expect(store.getReview(rid)!.status).toBe('running');
    store.finishReview(rid, { schemaVersion: 1 });
    expect(store.getReview(rid)).toMatchObject({ status: 'done', report: { schemaVersion: 1 } });

    store.deleteSnapshot(snap.id);
    expect(store.getSymbols(snap.id)).toHaveLength(0);
    store.close();
  });

  it('rebuilds the database when schema version differs', () => {
    const dbPath = path.join(tempDir(), 'index.db');
    const s = new Store(dbPath);
    s.createSnapshot('commit', 'abc', 'abc');
    s.close();
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 99));
    raw.close();
    const s2 = new Store(dbPath);
    expect(s2.rebuilt).toBe(true);
    expect(s2.listSnapshots()).toHaveLength(0);
    const s3 = new Store(dbPath);
    expect(s3.rebuilt).toBe(false);
    s2.close();
    s3.close();
  });

  it('rebuilds the database when the file is not a SQLite database', () => {
    const dbPath = path.join(tempDir(), 'index.db');
    writeFileSync(dbPath, 'this is not sqlite'.repeat(100));
    const s = new Store(dbPath);
    expect(s.rebuilt).toBe(true);
    s.createSnapshot('commit', 'abc', 'abc');
    expect(s.listSnapshots()).toHaveLength(1);
    s.close();
  });

  it('marks interrupted reviews as failed and keeps only 20', () => {
    const store = new Store(path.join(tempDir(), 'index.db'));
    for (let i = 0; i < 25; i++) store.createReview({ i });
    expect(store.listReviews(100)).toHaveLength(20);
    // 模拟一个已经退出的进程留下的任务
    store.db.prepare('UPDATE reviews SET pid = 999999999').run();
    expect(store.failInterruptedReviews()).toBe(20);
    expect(store.listReviews(1)[0]!.status).toBe('failed');
    store.close();
  });
});
