import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function tempDir(prefix = 'ci-test-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    },
  });
}

export function writeFiles(root: string, files: Record<string, string | null>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    if (content === null) {
      rmSync(p, { force: true });
      continue;
    }
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

/** 建临时仓库并提交一个初始版本，返回仓库路径 */
export function initRepo(files: Record<string, string>): string {
  const repo = tempDir('ci-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  writeFiles(repo, files);
  commitAll(repo, 'init');
  return repo;
}

export function commitAll(repo: string, message: string): string {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--allow-empty', '-m', message);
  return git(repo, 'rev-parse', 'HEAD').trim();
}
