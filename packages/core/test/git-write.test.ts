import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { batchSsh, fetchOriginBranch, nonInteractiveEnv, originDefaultBranch } from '../src/git/write.js';
import { git } from './helpers/git-repo.js';

function repoWithSshCommand(command?: string): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'ci-git-write-'));
  execFileSync('git', ['init', '-q', repo]);
  // 空值盖住本机全局配置里可能有的 core.sshCommand
  execFileSync('git', ['-C', repo, 'config', 'core.sshCommand', command ?? '']);
  return repo;
}

describe('non-interactive ssh command', () => {
  it('appends -batch for plink and BatchMode for OpenSSH', () => {
    expect(batchSsh('ssh')).toBe('ssh -o BatchMode=yes');
    expect(batchSsh('ssh -i ~/.ssh/key')).toBe('ssh -i ~/.ssh/key -o BatchMode=yes');
    expect(batchSsh('plink')).toBe('plink -batch');
    expect(batchSsh('"C:\\Program Files\\PuTTY\\plink.exe" -P 22')).toBe('"C:\\Program Files\\PuTTY\\plink.exe" -P 22 -batch');
    expect(batchSsh('/usr/local/bin/TortoisePlink.exe')).toBe('/usr/local/bin/TortoisePlink.exe -batch');
  });

  it('keeps GIT_SSH_COMMAND or core.sshCommand and adds the batch option', async () => {
    const repo = repoWithSshCommand('plink -load work');
    expect((await nonInteractiveEnv(repo, { GIT_SSH_COMMAND: 'ssh -p 2222' })).GIT_SSH_COMMAND).toBe('ssh -p 2222 -o BatchMode=yes');
    expect((await nonInteractiveEnv(repo, {})).GIT_SSH_COMMAND).toBe('plink -load work -batch');
    expect((await nonInteractiveEnv(repoWithSshCommand(), {})).GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes');
  });

  it('does not override GIT_SSH when it is the only ssh setting', async () => {
    const env = await nonInteractiveEnv(repoWithSshCommand(), { GIT_SSH: '/usr/bin/plink' });
    expect(env.GIT_SSH).toBe('/usr/bin/plink');
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
    expect(env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' });
  });
});

describe('fetching and the default branch of origin', () => {
  /** origin（裸仓库，默认分支 main，另有 release 分支）和它的单分支克隆 */
  function singleBranchClone(): { origin: string; clone: string } {
    const work = mkdtempSync(path.join(tmpdir(), 'ci-git-fetch-work-'));
    git(work, 'init', '-q', '-b', 'main');
    git(work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'one');
    git(work, 'branch', 'release');
    const origin = mkdtempSync(path.join(tmpdir(), 'ci-git-fetch-origin-'));
    execFileSync('git', ['clone', '-q', '--bare', work, origin]);
    const clone = mkdtempSync(path.join(tmpdir(), 'ci-git-fetch-clone-'));
    execFileSync('git', ['clone', '-q', '--single-branch', '--branch', 'main', origin, clone]);
    return { origin, clone };
  }

  it('fetches a branch that the fetch config of a single-branch clone does not cover', async () => {
    const { clone } = singleBranchClone();
    expect(() => git(clone, 'rev-parse', '--verify', '-q', 'refs/remotes/origin/release')).toThrow();
    await fetchOriginBranch(clone, 'release');
    expect(git(clone, 'rev-parse', 'refs/remotes/origin/release').trim()).toBe(git(clone, 'rev-parse', 'refs/remotes/origin/main').trim());
  });

  it('reads the default branch from origin/HEAD, and asks origin only when online', async () => {
    const { clone } = singleBranchClone();
    git(clone, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    expect(await originDefaultBranch(clone)).toBe('main');
    git(clone, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    expect(await originDefaultBranch(clone)).toBeUndefined();
    expect(await originDefaultBranch(clone, { online: {} })).toBe('main');
  });
});
