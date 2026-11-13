import { describe, expect, it } from 'vitest';
import { resolveRef, workingContentKey, workingKeyHasChanges } from '../src/index.js';
import { initRepo, writeFiles } from './helpers/git-repo.js';

describe('workingKeyHasChanges', () => {
  it('is false for a clean working tree and true with modified or untracked files', async () => {
    const repo = initRepo({ 'a.py': 'x = 1\n' });
    const head = await resolveRef(repo, 'HEAD');
    expect(workingKeyHasChanges(await workingContentKey(repo, head))).toBe(false);
    writeFiles(repo, { 'a.py': 'x = 2\n' });
    expect(workingKeyHasChanges(await workingContentKey(repo, head))).toBe(true);
    writeFiles(repo, { 'a.py': 'x = 1\n', 'new.py': 'y = 1\n' });
    expect(workingKeyHasChanges(await workingContentKey(repo, head))).toBe(true);
  });

  it('is false for keys without a change suffix', () => {
    expect(workingKeyHasChanges('abc123')).toBe(false);
  });
});
