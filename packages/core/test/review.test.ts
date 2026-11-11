import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initDataDir, loadConfig, reportToMarkdown, runReview, ScipPythonResolver, setLogSink, Store } from '../src/index.js';
import type { ResolveInput, Resolver, ReviewReport, SymbolChange } from '../src/index.js';
import { commitAll, git, initRepo, tempDir, writeFiles } from './helpers/git-repo.js';

const V1: Record<string, string> = {
  'pkg/__init__.py': '',
  'pkg/a.py': [
    'def keep():', '    return 1', '', '',
    'def change_body(x):', '    return x + 1', '', '',
    'def change_sig(x):', '    return x', '', '',
    'def gone():', "    return 'gone'", '', '',
    'def helper():', "    return 'from a: ' + str(keep())", '', '',
    'class Svc:', '    def run(self):', '        return keep()', '', '',
    'class Cfg:', "    name = 'old'", '', '    def get(self):', '        return self.name', '',
  ].join('\n'),
  'pkg/b.py': ['def other():', '    return 2', '', '', 'def helper():', '    total = 0', '    for i in range(10):', '        total += i', '    return total', ''].join('\n'),
  'pkg/use.py': ['from pkg.a import change_body, gone', '', '', 'def use():', '    return change_body(1) + len(gone())', ''].join('\n'),
  'tests/test_a.py': ['from pkg.a import change_body', '', '', 'def test_change_body():', '    assert change_body(1) == 2', ''].join('\n'),
  'README.md': '# demo\n',
};

const V2: Record<string, string | null> = {
  'pkg/a.py': [
    'def keep():', '    return 1', '', '',
    'def change_body(x):', '    return x + 2', '', '',
    'def change_sig(x, y=0):', '    return x', '', '',
    'def fresh():', '    return change_body(3)', '', '',
    'class Svc:', '    def run(self):', '        return keep() + 1', '', '',
    'class Cfg:', "    name = 'new'", '', '    def get(self):', '        return self.name', '',
  ].join('\n'),
  'pkg/b.py': ['def other():', '    return 2', ''].join('\n'),
  'pkg/c.py': ['from pkg.a import keep', '', '', 'def helper():', "    return 'from a: ' + str(keep())", ''].join('\n'),
  'pkg/d.py': ['def helper():', '    total = 0', '    for i in range(10):', '        total += i', '    return total', ''].join('\n'),
  'pkg/use.py': ['from pkg.a import change_body', '', '', 'def use():', '    return change_body(1)', ''].join('\n'),
  'README.md': '# demo\n\nmore\n',
};

let restoreSink: ((line: string) => void) | undefined;
const logLines: string[] = [];
const logLevel = process.env.CODEINSIGHT_LOG;
beforeAll(() => {
  process.env.CODEINSIGHT_LOG = 'info';
  restoreSink = setLogSink((line) => logLines.push(line));
});
afterAll(() => {
  if (restoreSink) setLogSink(restoreSink);
  if (logLevel === undefined) delete process.env.CODEINSIGHT_LOG;
  else process.env.CODEINSIGHT_LOG = logLevel;
});

interface ReviewArgs {
  base?: string;
  head?: string;
  working?: boolean;
  bin?: string;
  resolver?: Resolver;
}

interface Env {
  repo: string;
  review(opts?: ReviewArgs): Promise<ReviewReport>;
}

async function setup(repo: string): Promise<Env> {
  const config = await loadConfig(repo, { dataDir: tempDir('ci-data-') });
  const layout = await initDataDir(config.dataDir);
  return {
    repo,
    review: async (opts = {}) => {
      const store = new Store(layout.dbPath);
      try {
        const resolver = opts.resolver ?? new ScipPythonResolver({ bin: opts.bin });
        return await runReview({ repo, store, layout, config, base: opts.base, head: opts.head, working: opts.working, resolver });
      } finally {
        store.close();
      }
    },
  };
}

function twoCommitRepo(): string {
  const repo = initRepo(V1);
  writeFiles(repo, V2);
  commitAll(repo, 'v2: change a, move helpers');
  return repo;
}

function symbols(r: ReviewReport): SymbolChange[] {
  return r.modules.flatMap((m) => m.symbols);
}

function byName(r: ReviewReport, qualifiedName: string, filePath?: string): SymbolChange[] {
  return symbols(r).filter((s) => s.qualifiedName === qualifiedName && (!filePath || s.path === filePath));
}

function failingBin(): string {
  const file = path.join(tempDir('ci-bin-'), 'fail.mjs');
  writeFileSync(file, 'console.error("boom from fake scip-python"); process.exit(3);\n');
  return file;
}

describe('review between two commits', () => {
  let report: ReviewReport;

  beforeAll(async () => {
    const env = await setup(twoCommitRepo());
    report = await env.review({ head: 'HEAD' });
  }, 120_000);

  it('resolves base to head~1 and records both snapshots', () => {
    expect(report.schemaVersion).toBe(1);
    expect(report.head).toMatchObject({ ref: 'HEAD', working: false });
    expect(report.base.ref).toBe('HEAD~1');
    expect(report.base.snapshotId).not.toBe(report.head.snapshotId);
    expect(report.intent).toEqual({ source: 'commits', text: expect.stringContaining('v2: change a, move helpers') });
    expect(report.warnings.filter((w) => w.code.startsWith('resolver'))).toEqual([]);
  });

  it('lists added and removed functions', () => {
    expect(byName(report, 'fresh')).toMatchObject([{ change: 'added', path: 'pkg/a.py', displaySignature: '()' }]);
    expect(byName(report, 'gone')).toMatchObject([{ change: 'removed', path: 'pkg/a.py' }]);
  });

  it('marks body and signature changes as modified, with the old signature when it changed', () => {
    const body = byName(report, 'change_body')[0]!;
    expect(body.change).toBe('modified');
    expect(body.displaySignatureBefore).toBeUndefined();
    expect(byName(report, 'change_sig')).toMatchObject([{ change: 'modified', displaySignature: '(x, y=0)', displaySignatureBefore: '(x)' }]);
    expect(byName(report, 'keep')).toEqual([]);
  });

  it('pairs two same-name functions that moved at the same time one to one by body', () => {
    expect(byName(report, 'helper', 'pkg/c.py')).toMatchObject([{ change: 'moved', movedFrom: 'pkg/a.py#function#helper#' }]);
    expect(byName(report, 'helper', 'pkg/d.py')).toMatchObject([{ change: 'moved', movedFrom: 'pkg/b.py#function#helper#' }]);
    expect(symbols(report).filter((s) => s.name === 'helper')).toHaveLength(2);
  });

  it('lists a class only when its own part changed, not when only a method changed', () => {
    expect(byName(report, 'Svc.run')).toMatchObject([{ change: 'modified', kind: 'method' }]);
    expect(byName(report, 'Svc')).toEqual([]);
    expect(byName(report, 'Cfg')).toMatchObject([{ change: 'modified', kind: 'class' }]);
    expect(symbols(report).filter((s) => s.kind === 'module')).toEqual([]);
  });

  it('counts production and test callers on head, and removed symbols on base', () => {
    const body = byName(report, 'change_body')[0]!;
    expect(body.callers).toMatchObject({ prod: 2, test: 1 });
    expect(body.callers.topProd.map((c) => c.qualifiedName).sort()).toEqual(['fresh', 'use']);
    expect(body.impact).toMatchObject({ depth: 2, prod: 2, test: 1 });
    expect(byName(report, 'gone')[0]!.callers).toMatchObject({ prod: 1, test: 0, topProd: [{ qualifiedName: 'use' }] });
  });

  it('reports call edge changes of changed symbols, ignoring moves', () => {
    const edges = report.edgeChanges.map((e) => `${e.change} ${e.kind} ${e.src.qualifiedName} -> ${e.dst.qualifiedName}`);
    expect(edges).toContain('removed call use -> gone');
    expect(edges).toContain('added call fresh -> change_body');
    expect(edges.filter((e) => e.includes('helper ->'))).toEqual([]);
  });

  it('groups by module and lists unsupported files with a warning', () => {
    expect(report.modules.map((m) => m.module)).toEqual(['pkg']);
    expect(report.files.find((f) => f.path === 'README.md')).toMatchObject({ status: 'modified', supportLevel: 'none' });
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'language_unsupported', path: 'README.md' }));
    expect(report.files.find((f) => f.path === 'tests/test_a.py')).toBeUndefined();
  });

  it('renders markdown', () => {
    const md = reportToMarkdown(report);
    expect(md).toContain('### pkg');
    expect(md).toContain('`(x)` → `(x, y=0)`');
    expect(md).toContain('moved from `pkg/a.py#function#helper#`');
    expect(md).toContain('language_unsupported');
  });
});

describe('review when scip-python fails', () => {
  it('still outputs the function-level diff and a resolver_failed warning', async () => {
    const env = await setup(twoCommitRepo());
    const report = await env.review({ head: 'HEAD', bin: failingBin() });
    expect(report.warnings.filter((w) => w.code === 'resolver_failed').map((w) => w.side).sort()).toEqual(['base', 'head']);
    expect(report.warnings.find((w) => w.code === 'resolver_failed')!.message).toContain('boom from fake scip-python');
    expect(byName(report, 'fresh')).toMatchObject([{ change: 'added', callers: { prod: 0, test: 0 } }]);
    expect(byName(report, 'change_sig')).toMatchObject([{ change: 'modified', displaySignatureBefore: '(x)' }]);
    expect(byName(report, 'helper', 'pkg/c.py')).toMatchObject([{ change: 'moved' }]);
    expect(report.edgeChanges).toEqual([]);
  }, 60_000);
});

describe('review of the working tree', () => {
  it('compares uncommitted and untracked changes against HEAD', async () => {
    const repo = initRepo(V1);
    writeFiles(repo, { 'pkg/a.py': V1['pkg/a.py']!.replace("return 'gone'", "return 'still here'"), 'pkg/new.py': 'def brand_new():\n    return 0\n' });
    const env = await setup(repo);
    const report = await env.review();
    expect(report.head).toMatchObject({ ref: 'WORKING', working: true });
    expect(report.base.ref).toBe('HEAD');
    expect(report.base.sha).toBe(report.head.sha);
    expect(report.intent).toBeUndefined();
    expect(symbols(report).map((s) => `${s.change} ${s.qualifiedName}`).sort()).toEqual(['added brand_new', 'modified gone']);
    expect(git(repo, 'status', '--porcelain')).toBe(' M pkg/a.py\n?? pkg/new.py\n');
  }, 120_000);

  it('rejects --head together with --working', async () => {
    const env = await setup(initRepo(V1));
    const config = await loadConfig(env.repo, { dataDir: tempDir('ci-data-') });
    const layout = await initDataDir(config.dataDir);
    const store = new Store(layout.dbPath);
    await expect(runReview({ repo: env.repo, store, layout, config, head: 'HEAD', working: true })).rejects.toThrow('cannot be used together');
    store.close();
  });
});

/** 只让 base 版本的解析失败，head 照常用 scip-python */
class FailOnBase implements Resolver {
  readonly name = 'fail-on-base';
  private readonly real = new ScipPythonResolver();
  constructor(private readonly baseSha: string) {}
  resolve(input: ResolveInput) {
    if (input.contentKey === this.baseSha) return Promise.reject(new Error('base resolver boom'));
    return this.real.resolve(input);
  }
}

describe('review edge cases', () => {
  it('keeps head callers when only the base resolver fails', async () => {
    const repo = twoCommitRepo();
    const env = await setup(repo);
    const report = await env.review({ head: 'HEAD', resolver: new FailOnBase(git(repo, 'rev-parse', 'HEAD~1').trim()) });
    expect(report.warnings.filter((w) => w.code === 'resolver_failed')).toMatchObject([{ side: 'base', message: expect.stringContaining('base resolver boom') }]);
    expect(byName(report, 'change_body')[0]!.callers).toMatchObject({ prod: 2, test: 1 });
    expect(byName(report, 'gone')[0]!.callers).toMatchObject({ prod: 0, test: 0 });
    expect(report.edgeChanges).toEqual([]);
  }, 120_000);

  it('skips both snapshots when no changed file is in a supported language', async () => {
    const repo = initRepo(V1);
    writeFiles(repo, { 'README.md': '# changed\n' });
    commitAll(repo, 'docs only');
    const env = await setup(repo);
    const before = logLines.length;
    const report = await env.review({ head: 'HEAD' });
    const logs = logLines.slice(before);
    expect(logs.some((l) => l.includes('review_snapshots_skipped'))).toBe(true);
    expect(logs.filter((l) => l.includes('snapshot_build_start') || l.includes('scip_python_start'))).toEqual([]);
    expect(report).toMatchObject({ base: { snapshotId: null }, head: { snapshotId: null }, modules: [], edgeChanges: [] });
    expect(report.files).toMatchObject([{ path: 'README.md', status: 'modified' }]);
    expect(report.warnings).toMatchObject([{ code: 'language_unsupported', path: 'README.md' }]);
  });

  it('compares the first commit with the empty tree', async () => {
    const env = await setup(initRepo(V1));
    const report = await env.review({ head: 'HEAD' });
    expect(report.base).toMatchObject({ ref: '(empty tree)', snapshotId: null });
    expect(report.head.snapshotId).not.toBeNull();
    expect(report.files.every((f) => f.status === 'added')).toBe(true);
    const changes = symbols(report);
    expect(changes.every((c) => c.change === 'added')).toBe(true);
    expect(changes.map((c) => c.qualifiedName)).toContain('change_body');
    expect(byName(report, 'change_body')[0]!.callers).toMatchObject({ prod: 1, test: 1 });
    expect(report.warnings.filter((w) => w.code.startsWith('resolver'))).toEqual([]);
  }, 120_000);

  it('reviews the HEAD commit when working is false and no head is given', async () => {
    const env = await setup(twoCommitRepo());
    const report = await env.review({ working: false });
    expect(report.head).toMatchObject({ ref: 'HEAD', working: false });
    expect(report.base.ref).toBe('HEAD~1');
    expect(byName(report, 'fresh')).toMatchObject([{ change: 'added' }]);
  }, 120_000);
});
