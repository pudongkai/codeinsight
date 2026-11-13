import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AddDirError } from '@codeinsight/core';
import { startHttpServer, type RunningHttpServer } from '../src/index.js';
import { apiFor, fixtureRepo, openWorkspace, tempDir } from './helpers/env.js';

let home: string;
const servers: RunningHttpServer[] = [];

beforeAll(() => {
  process.env.CODEINSIGHT_LOG = 'silent';
  home = realpathSync(tempDir('ci-write-status-home-'));
  for (const d of ['notes', 'docs', '.ssh']) mkdirSync(path.join(home, d));
});

afterAll(async () => {
  for (const s of servers) await s.close({ drain: false });
});

// 测试目录都在系统临时目录下（macOS 上是 /private/var/...），所以系统目录名单换成空的
const addDirCheck = () => ({ home, systemDirs: [] });

describe('write scope in /api/status', () => {
  it('lists the repository and the --add-dir directory names, without absolute paths', async () => {
    const repo = fixtureRepo();
    const ws = await openWorkspace(repo, tempDir('ci-write-status-data-'));
    const server = await startHttpServer({
      workspace: ws, indexOnStart: false, staticDir: tempDir('ci-web-'), env: {},
      addDirs: [path.join(home, 'notes'), path.join(home, 'docs'), path.join(home, 'notes')], addDirCheck: addDirCheck(),
    });
    servers.push(server);
    const { status, body } = await apiFor(server)<{ writeScope: unknown }>('/api/status');
    expect(status).toBe(200);
    expect(body.writeScope).toEqual({ repo: true, dirs: ['notes', 'docs'] });
    expect(JSON.stringify(body.writeScope)).not.toContain(home);
  });

  it('without a repository and without --add-dir nothing is writable', async () => {
    const server = await startHttpServer({ staticDir: tempDir('ci-web-'), env: {}, dirPicker: { tool: null } });
    servers.push(server);
    const { body } = await apiFor(server)<{ writeScope: unknown }>('/api/status');
    expect(body.writeScope).toEqual({ repo: false, dirs: [] });
  });

  it('fails to start when an --add-dir is not allowed, and closes the workspace store', async () => {
    const repo = fixtureRepo();
    for (const bad of [path.join(home, '.ssh'), path.join(home, 'missing'), home, path.join(repo, '.git')]) {
      const ws = await openWorkspace(repo, tempDir('ci-write-status-data-'));
      const err = await startHttpServer({ workspace: ws, indexOnStart: false, env: {}, addDirs: [bad], addDirCheck: addDirCheck() }).then(() => undefined, (e: unknown) => e);
      expect(err, bad).toBeInstanceOf(AddDirError);
      expect((err as Error).message).toContain(`--add-dir ${bad}:`);
      expect(() => ws.store.chats.listSessions()).toThrow();
    }
  });
});
