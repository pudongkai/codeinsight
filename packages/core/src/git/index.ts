import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { log } from '../log.js';

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

const toplevelCache = new Map<string, Promise<string>>();

/** 仓库根目录（带缓存）。传入子目录时，下面的函数一律按仓库根目录工作，路径都相对仓库根目录 */
function toplevel(repo: string): Promise<string> {
  const key = path.resolve(repo);
  let p = toplevelCache.get(key);
  if (!p) {
    p = repoRoot(key);
    p.catch(() => toplevelCache.delete(key));
    toplevelCache.set(key, p);
  }
  return p;
}

export async function resolveRef(repo: string, ref: string): Promise<string> {
  return (await runGit(repo, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
}

function splitZ(out: string): string[] {
  return out.split('\0').filter((s) => s.length > 0);
}

/** 提交版本的文件清单（不含子模块） */
export async function listCommitFiles(repo: string, sha: string): Promise<string[]> {
  return (await listCommitBlobs(repo, sha)).map((e) => e.path).sort();
}

async function listCommitBlobs(repo: string, sha: string): Promise<TreeEntry[]> {
  const out = await runGit(await toplevel(repo), ['ls-tree', '-r', '-z', '--full-tree', sha]);
  return parseLsTree(out).filter((e) => e.type === 'blob');
}

/** 解析 `ls-files --stage -z`：`<mode> <oid> <stage>\t<path>` */
function parseLsFilesStage(out: string): { mode: string; path: string }[] {
  return splitZ(out).map((line) => {
    const tab = line.indexOf('\t');
    return { mode: line.slice(0, line.indexOf(' ')), path: line.slice(tab + 1) };
  });
}

function dirPrefixes(excludeDirs: string[]): string[] {
  return excludeDirs.map((d) => d.replace(/\/+$/, '') + '/');
}

function isExcluded(file: string, prefixes: string[]): boolean {
  return prefixes.some((p) => file.startsWith(p));
}

/** 未跟踪且没被忽略的文件，排除 excludeDirs；root 必须是仓库根目录 */
async function listUntracked(root: string, prefixes: string[]): Promise<string[]> {
  const out = splitZ(await runGit(root, ['ls-files', '-z', '--others', '--exclude-standard']));
  return out.filter((f) => !isExcluded(f, prefixes));
}

/**
 * 工作区文件清单：已跟踪文件 + 未跟踪且没被忽略的文件，排除 excludeDirs（仓库内的数据目录）。
 * 已删除但未提交的跟踪文件不在清单里。
 */
export async function listWorkingFiles(repo: string, excludeDirs: string[] = []): Promise<string[]> {
  const root = await toplevel(repo);
  const prefixes = dirPrefixes(excludeDirs);
  const tracked = parseLsFilesStage(await runGit(root, ['ls-files', '-z', '--stage']))
    .filter((e) => e.mode !== '160000')
    .map((e) => e.path);
  const deleted = new Set(splitZ(await runGit(root, ['ls-files', '-z', '--deleted'])));
  const all = new Set<string>(await listUntracked(root, prefixes));
  for (const f of tracked) {
    if (!deleted.has(f) && !isExcluded(f, prefixes)) all.add(f);
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

/** 不受用户 git 配置（diff.relative、颜色、外部 diff 工具）影响；子模块不参与比较 */
const DIFF_ARGS = ['diff', '-z', '-M', '--no-relative', '--no-color', '--no-ext-diff', '--ignore-submodules=all'];

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
  const out = await runGit(repo, [...DIFF_ARGS, '--numstat', ...args]);
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
  const root = await toplevel(repo);
  const files = parseNameStatus(await runGit(root, [...DIFF_ARGS, '--name-status', base, head]));
  await applyNumstat(root, [base, head], files);
  return files;
}

/** base 提交与工作区之间的改动文件，包含未跟踪文件，排除 excludeDirs */
export async function diffWorking(repo: string, base: string, excludeDirs: string[] = []): Promise<ChangedFile[]> {
  const root = await toplevel(repo);
  const prefixes = dirPrefixes(excludeDirs);
  const files = parseNameStatus(await runGit(root, [...DIFF_ARGS, '--name-status', base]))
    .filter((f) => !isExcluded(f.path, prefixes));
  await applyNumstat(root, [base], files);
  for (const p of await listUntracked(root, prefixes)) {
    const content = await readFile(path.join(root, p), 'utf8').catch(() => '');
    files.push({ path: p, status: 'added', additions: countLines(content), deletions: 0 });
  }
  return files;
}

function countLines(s: string): number {
  if (s.length === 0) return 0;
  return s.split('\n').length - (s.endsWith('\n') ? 1 : 0);
}

interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  path: string;
}

function parseLsTree(out: string): TreeEntry[] {
  return splitZ(out).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, type, oid] = line.slice(0, tab).split(' ') as [string, string, string];
    return { mode, type, oid, path: line.slice(tab + 1) };
  });
}

/** 用 `git cat-file --batch` 依次读出 oids 对应的对象内容，按输入顺序回调 */
async function streamBlobs(root: string, oids: string[], onBlob: (index: number, data: Buffer) => Promise<void>): Promise<void> {
  const git = spawn('git', ['-C', root, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  git.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise<number | null>((resolve, reject) => {
    git.on('error', reject);
    git.on('close', resolve);
  });
  git.stdin.on('error', () => undefined); // git 提前退出时由下面的退出码报告错误
  git.stdin.end(oids.join('\n') + (oids.length ? '\n' : ''));
  let count: number;
  try {
    count = await consumeBatch(git.stdout as AsyncIterable<Buffer>, onBlob);
  } catch (err) {
    git.kill();
    throw err;
  }
  const code = await exited;
  if (code !== 0 || count !== oids.length) throw new GitError(`git cat-file --batch failed: ${stderr.trim()}`);
}

/** 解析 `git cat-file --batch` 的输出流，返回读到的对象个数。每个对象按头部给出的大小一次分配内存 */
async function consumeBatch(stream: AsyncIterable<Buffer>, onBlob: (index: number, data: Buffer) => Promise<void>): Promise<number> {
  let header: Buffer = Buffer.alloc(0);
  let body: Buffer | undefined;
  let filled = 0;
  let index = 0;
  for await (const chunk of stream) {
    let pos = 0;
    while (pos < chunk.length) {
      if (!body) {
        const nl = chunk.indexOf(10, pos);
        header = Buffer.concat([header, chunk.subarray(pos, nl < 0 ? chunk.length : nl)]);
        if (nl < 0) break;
        pos = nl + 1;
        body = Buffer.allocUnsafe(parseBatchHeader(header.toString('utf8')) + 1);
        header = Buffer.alloc(0);
        filled = 0;
      }
      const n = chunk.copy(body, filled, pos);
      filled += n;
      pos += n;
      if (filled === body.length) {
        await onBlob(index++, body.subarray(0, body.length - 1));
        body = undefined;
      }
    }
  }
  return index;
}

/** 解析对象头 `<oid> <type> <size>`，返回内容字节数 */
function parseBatchHeader(header: string): number {
  const size = Number(header.split(' ')[2]);
  if (header.endsWith(' missing') || !Number.isInteger(size) || size < 0) {
    throw new GitError(`git cat-file: unexpected header "${header}"`);
  }
  return size;
}

/**
 * 导出提交的源码，不建 worktree、不改用户仓库。
 * 直接按 ls-tree 读对象内容写出，不受 .gitattributes 的 export-ignore / export-subst 影响，
 * 导出结果和 listCommitFiles、readFileAtCommit 一致。子模块跳过；dest 已存在时先清空。
 */
export async function exportArchive(repo: string, sha: string, dest: string): Promise<void> {
  const root = await toplevel(repo);
  const entries = await listCommitBlobs(root, sha);
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  const dirs = new Set(entries.map((e) => path.dirname(path.join(dest, e.path))));
  for (const d of dirs) await mkdir(d, { recursive: true });
  await streamBlobs(root, entries.map((e) => e.oid), async (i, data) => {
    const e = entries[i]!;
    const target = path.join(dest, e.path);
    if (e.mode === '120000') {
      await symlink(data.toString('utf8'), target);
    } else {
      await writeFile(target, data);
      if (e.mode === '100755') await chmod(target, 0o755);
    }
  });
  log.info('snapshot_exported', { sha, files: entries.length });
}

/**
 * 工作区内容 key：HEAD sha + 相对 HEAD 改动的文件（含未跟踪文件）的内容 hash。
 * 文件内容不变时 key 不变，用于复用工作区快照。
 */
export async function workingContentKey(repo: string, headSha: string, excludeDirs: string[] = []): Promise<string> {
  const root = await toplevel(repo);
  const changed = await diffWorking(root, headSha, excludeDirs);
  const h = createHash('sha1');
  for (const f of [...changed].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(f.path).update('\0');
    if (f.status === 'removed') {
      h.update('<removed>');
    } else {
      h.update(await readFile(path.join(root, f.path)).catch(() => Buffer.from('<unreadable>')));
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
