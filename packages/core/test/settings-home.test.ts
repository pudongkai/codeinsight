import { realpathSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readUserSettings, touchRecentRepo } from '../src/index.js';
import { tempDir } from './helpers/git-repo.js';

// 和 settings.test.ts 各自往默认位置写最近列表：每个测试文件的 CODEINSIGHT_HOME 不同，互相看不到对方的条目
describe('user settings isolation between test files', () => {
  it('only sees the recent repositories written by this file', async () => {
    const repo = tempDir('ci-recent-other-');
    await touchRecentRepo(repo);
    expect((await readUserSettings()).recentRepos.map((r) => r.path)).toEqual([realpathSync(repo)]);
  });
});
