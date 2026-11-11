import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export class GitError extends Error {}

export async function runGit(repo: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP('git', ['-C', repo, ...args], {
      maxBuffer: 256 * 1024 * 1024,
      encoding: 'utf8',
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new GitError(`git ${args.join(' ')} failed: ${(e.stderr ?? e.message).trim()}`);
  }
}

export async function repoRoot(repo: string): Promise<string> {
  return (await runGit(repo, ['rev-parse', '--show-toplevel'])).trim();
}

export async function resolveRef(repo: string, ref: string): Promise<string> {
  return (await runGit(repo, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
}

function splitZ(out: string): string[] {
  return out.split('\0').filter((s) => s.length > 0);
}

/** 提交版本的文件清单 */
export async function listCommitFiles(repo: string, sha: string): Promise<string[]> {
  return splitZ(await runGit(repo, ['ls-tree', '-r', '-z', '--name-only', sha])).sort();
}

/**
 * 工作区文件清单：已跟踪文件 + 未跟踪且没被忽略的文件，排除 excludeDirs（仓库内的数据目录）。
 * 已删除但未提交的跟踪文件不在清单里。
 */
export async function listWorkingFiles(repo: string, excludeDirs: string[] = []): Promise<string[]> {
  const tracked = splitZ(await runGit(repo, ['ls-files', '-z']));
  const deleted = new Set(splitZ(await runGit(repo, ['ls-files', '-z', '--deleted'])));
  const untracked = splitZ(await runGit(repo, ['ls-files', '-z', '--others', '--exclude-standard']));
  const prefixes = excludeDirs.map((d) => d.replace(/\/+$/, '') + '/');
  const all = new Set<string>();
  for (const f of [...tracked, ...untracked]) {
    if (deleted.has(f)) continue;
    if (prefixes.some((p) => f.startsWith(p))) continue;
    all.add(f);
  }
  return [...all].sort();
}

export type ChangeStatus = 'added' | 'removed' | 'modified' | 'renamed';

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  additions: number;
  deletions: number;
}

function mapStatus(code: string): ChangeStatus {
  switch (code[0]) {
    case 'A':
      return 'added';
    case 'D':
      return 'removed';
    case 'R':
      return 'renamed';
    default:
      return 'modified';
  }
}

function parseNameStatus(out: string): ChangedFile[] {
  const tokens = splitZ(out);
  const files: ChangedFile[] = [];
  for (let i = 0; i < tokens.length; ) {
    const code = tokens[i++]!;
    const status = mapStatus(code);
    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = tokens[i++]!;
      const newPath = tokens[i++]!;
      files.push(code.startsWith('C')
        ? { path: newPath, status: 'added', additions: 0, deletions: 0 }
        : { path: newPath, oldPath, status, additions: 0, deletions: 0 });
    } else {
      files.push({ path: tokens[i++]!, status, additions: 0, deletions: 0 });
    }
  }
  return files;
}

async function applyNumstat(repo: string, args: string[], files: ChangedFile[]): Promise<void> {
  const out = await runGit(repo, ['diff', '--numstat', '-z', '-M', ...args]);
  const tokens = out.split('\0');
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(t);
    if (!m) continue;
    let p = m[3]!;
    if (p === '') {
      // 重命名：后面两个 token 是旧路径和新路径
      i += 2;
      p = tokens[i] ?? '';
    }
    const f = byPath.get(p);
    if (f) {
      f.additions = m[1] === '-' ? 0 : Number(m[1]);
      f.deletions = m[2] === '-' ? 0 : Number(m[2]);
    }
  }
}

/** 两个提交之间的改动文件 */
export async function diffCommits(repo: string, base: string, head: string): Promise<ChangedFile[]> {
  const files = parseNameStatus(await runGit(repo, ['diff', '--name-status', '-z', '-M', base, head]));
  await applyNumstat(repo, [base, head], files);
  return files;
}

/** base 提交与工作区之间的改动文件，包含未跟踪文件，排除 excludeDirs */
export async function diffWorking(repo: string, base: string, excludeDirs: string[] = []): Promise<ChangedFile[]> {
  const files = parseNameStatus(await runGit(repo, ['diff', '--name-status', '-z', '-M', base]));
  await applyNumstat(repo, [base], files);
  const untracked = splitZ(await runGit(repo, ['ls-files', '-z', '--others', '--exclude-standard']));
  const prefixes = excludeDirs.map((d) => d.replace(/\/+$/, '') + '/');
  for (const p of untracked) {
    if (prefixes.some((x) => p.startsWith(x))) continue;
    const content = await readFile(path.join(repo, p), 'utf8').catch(() => '');
    files.push({ path: p, status: 'added', additions: countLines(content), deletions: 0 });
  }
  return files.filter((f) => !prefixes.some((x) => f.path.startsWith(x)));
}

function countLines(s: string): number {
  if (s.length === 0) return 0;
  return s.split('\n').length - (s.endsWith('\n') ? 1 : 0);
}

/** 用 git archive 导出提交的源码，不建 worktree、不改用户仓库 */
export async function exportArchive(repo: string, sha: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const git = spawn('git', ['-C', repo, 'archive', '--format=tar', sha], { stdio: ['ignore', 'pipe', 'pipe'] });
    const tar = spawn('tar', ['-x', '-C', dest], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    git.stderr.on('data', (d) => (stderr += d));
    tar.stderr.on('data', (d) => (stderr += d));
    git.stdout.pipe(tar.stdin);
    let pending = 2;
    let failed = false;
    const done = (code: number | null) => {
      if (code !== 0 && !failed) {
        failed = true;
        reject(new GitError(`git archive ${sha} failed: ${stderr.trim()}`));
      }
      if (--pending === 0 && !failed) resolve();
    };
    git.on('close', done);
    tar.on('close', done);
    git.on('error', reject);
    tar.on('error', reject);
  });
}

/**
 * 工作区内容 key：HEAD sha + 相对 HEAD 改动的文件（含未跟踪文件）的内容 hash。
 * 文件内容不变时 key 不变，用于复用工作区快照。
 */
export async function workingContentKey(repo: string, headSha: string, excludeDirs: string[] = []): Promise<string> {
  const changed = await diffWorking(repo, headSha, excludeDirs);
  const h = createHash('sha1');
  for (const f of [...changed].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(f.path).update('\0');
    if (f.status === 'removed') {
      h.update('<removed>');
    } else {
      h.update(await readFile(path.join(repo, f.path)).catch(() => Buffer.from('<unreadable>')));
    }
    h.update('\0');
  }
  return `${headSha}-${h.digest('hex').slice(0, 16)}`;
}

export async function readFileAtCommit(repo: string, sha: string, filePath: string): Promise<string> {
  return runGit(repo, ['show', `${sha}:${filePath}`]);
}

/** 区间 (base, head] 的提交说明，作为默认意图文本 */
export async function commitMessages(repo: string, base: string, head: string): Promise<string> {
  return (await runGit(repo, ['log', '--format=%B%n---', `${base}..${head}`])).trim();
}
