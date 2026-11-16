import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findCommand } from '../src/index.js';
import { tempDir } from './helpers/git-repo.js';

function executable(dir: string, name: string): string {
  const f = path.join(dir, name);
  writeFileSync(f, '#!/bin/sh\n');
  chmodSync(f, 0o755);
  return f;
}

describe.skipIf(process.platform === 'win32')('findCommand', () => {
  it('uses the environment variable, then PATH, then the extra directories', () => {
    const extra = tempDir();
    const inExtra = executable(extra, 'scip-go');
    const base = { home: tempDir(), noCache: true, extraDirs: [extra] };
    expect(findCommand('scip-go', { ...base, env: { PATH: '' } })).toEqual({ ok: true, path: inExtra });

    const onPath = executable(tempDir(), 'scip-go');
    expect(findCommand('scip-go', { ...base, env: { PATH: path.dirname(onPath) } })).toEqual({ ok: true, path: onPath });

    const pinned = executable(tempDir(), 'my-scip-go');
    const env = { PATH: path.dirname(onPath), CODEINSIGHT_SCIP_GO: pinned };
    expect(findCommand('scip-go', { ...base, envVar: 'CODEINSIGHT_SCIP_GO', env })).toEqual({ ok: true, path: pinned });
  });

  it('reports a missing command', () => {
    const r = findCommand('no-such-tool-xyz', { env: { PATH: tempDir() }, home: tempDir(), noCache: true });
    expect(r).toMatchObject({ ok: false, kind: 'command_not_found' });
  });
});
