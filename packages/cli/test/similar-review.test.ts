import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';

const CLAUVE = process.env.CODEINSIGHT_CLAUVE?.replace(/^~(?=$|\/)/, homedir());

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
}

function repoFn(name: string, sql: string): string {
  return [`def ${name}(user_id, conn=None):`, '    with _use(conn) as c:', '        with c.cursor() as cur:', `            cur.execute("${sql}", (user_id,))`, '            row = cur.fetchone()', '            return row[0] if row else None', '', ''].join('\n');
}

const SQL = 'SELECT email FROM app_user WHERE user_id = %s';

/** 第一个提交有 select_user_email，第二个提交新增一份函数体相同的 get_email_of_user */
function makeRepo(): string {
  const repo = tempDir('ci-cli-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, { 'pkg/__init__.py': '', 'pkg/repo.py': 'def _use(conn):\n    return conn\n\n\n' + repoFn('select_user_email', SQL) });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  write(repo, { 'pkg/new.py': 'from pkg.repo import _use\n\n\n' + repoFn('get_email_of_user', SQL) });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Add an email lookup');
  return repo;
}

/** 在进程内运行 CLI，收集 stdout 和 stderr */
async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((out += String(chunk)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => ((err += String(chunk)), true));
  try {
    const code = await runCli(argv);
    return { code, out, err };
  } finally {
    vi.restoreAllMocks();
  }
}

beforeAll(() => {
  process.env.CODEINSIGHT_LOG = 'silent';
  for (const k of ['CODEINSIGHT_LLM_PROVIDER', 'CODEINSIGHT_LLM_MODEL', 'CODEINSIGHT_LLM_API_KEY', 'CODEINSIGHT_LLM_BASE_URL', 'CODEINSIGHT_DATA_DIR']) delete process.env[k];
});

afterEach(() => vi.restoreAllMocks());

interface SimilarJson {
  findings: { symbol: { name: string; path: string }; candidates: { symbol: { name: string; path: string }; score: number }[] }[];
}

describe('codeinsight similar', () => {
  it('scans all functions with --all and looks up one function with --symbol', async () => {
    const repo = makeRepo();
    const dataDir = tempDir('ci-cli-data-');
    const all = await cli('similar', '--all', '--repo', repo, '--data-dir', dataDir);
    expect(all.code).toBe(0);
    const json = JSON.parse(all.out) as SimilarJson;
    const pair = json.findings.flatMap((f) => f.candidates.map((c) => [f.symbol.name, c.symbol.name].sort().join(' ~ ')));
    expect(pair).toEqual(['get_email_of_user ~ select_user_email']);

    const one = await cli('similar', '--symbol', 'pkg/new.py#function#get_email_of_user#', '--format', 'md', '--repo', repo, '--data-dir', dataDir);
    expect(one.code).toBe(0);
    expect(one.out).toContain('## Duplicates');
    expect(one.out).toContain('`select_user_email` (`pkg/repo.py:5`)');
  }, 120_000);

  it('rejects missing or conflicting modes and unknown symbols with exit code 1', async () => {
    const repo = makeRepo();
    expect((await cli('similar', '--repo', repo)).code).toBe(1);
    expect((await cli('similar', '--all', '--symbol', 'x', '--repo', repo)).code).toBe(1);
    const missing = await cli('similar', '--symbol', 'pkg/nope.py#function#f#', '--repo', repo, '--data-dir', tempDir('ci-cli-data-'));
    expect(missing).toMatchObject({ code: 1, err: expect.stringContaining('symbol not found') });
  }, 120_000);
});

describe('codeinsight review with intent options', () => {
  it('reads --intent-file, reports duplicates, and warns that no LLM is configured', async () => {
    const repo = makeRepo();
    const intentFile = path.join(tempDir('ci-cli-intent-'), 'task.md');
    writeFileSync(intentFile, 'Add an email lookup for users\n');
    const r = await cli('review', '--repo', repo, '--head', 'HEAD', '--intent-file', intentFile, '--data-dir', tempDir('ci-cli-data-'));
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as { intent: unknown; intentCheck?: unknown; duplicates: SimilarJson['findings']; warnings: { code: string }[] };
    expect(report.intent).toEqual({ source: 'file', text: 'Add an email lookup for users\n' });
    expect(report.intentCheck).toBeUndefined();
    expect(report.warnings.map((w) => w.code)).toContain('llm_not_configured');
    expect(report.duplicates.map((f) => `${f.symbol.name} ~ ${f.candidates[0]!.symbol.name}`)).toEqual(['get_email_of_user ~ select_user_email']);
  }, 120_000);

  it('accepts --no-llm and rejects --intent together with --intent-file', async () => {
    const repo = makeRepo();
    const r = await cli('review', '--repo', repo, '--head', 'HEAD', '--no-llm', '--format', 'md', '--data-dir', tempDir('ci-cli-data-'));
    expect(r.code).toBe(0);
    expect(r.out).toContain('llm_disabled');
    expect(r.out).toContain('## Possible duplicates');
    expect((await cli('review', '--repo', repo, '--intent', 'a', '--intent-file', 'b')).code).toBe(1);
  }, 120_000);
});

describe.skipIf(!CLAUVE)('codeinsight similar --all on clauve (CODEINSIGHT_CLAUVE)', () => {
  it('finds the four known duplicate groups at 80cf8e1', async () => {
    const repo = path.resolve(CLAUVE!);
    const statusBefore = git(repo, 'status', '--porcelain');
    const r = await cli('similar', '--all', '--ref', '80cf8e1', '--repo', repo, '--data-dir', tempDir('ci-cli-clauve-'));
    expect(r.code).toBe(0);
    const { findings } = JSON.parse(r.out) as SimilarJson;
    const groups = ['select_org_by_id', '_ensure_same_org', 'select_user_org_id', 'insert_lease'];
    const missing = groups.filter((name) => !findings.some((f) => f.symbol.name === name && f.candidates.some((c) => c.symbol.name === name)));
    expect(missing).toEqual([]);
    expect(git(repo, 'status', '--porcelain')).toBe(statusBefore);
  }, 600_000);
});
