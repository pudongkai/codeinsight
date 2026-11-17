import { describe, expect, it, vi } from 'vitest';
import {
  EXACT_BODY_QUERY_MAX,
  extractFiles,
  extractPythonFiles,
  findDuplicates,
  initDataDir,
  loadConfig,
  LshIndex,
  minhash,
  nameTokens,
  runReview,
  rustCratesFromManifests,
  shingles,
  signatureShape,
  similarToCode,
  Store,
} from '../src/index.js';
import { jaccard } from '../src/util/collections.js';
import type { DuplicateFinding, SymbolRow } from '../src/index.js';
import { commitAll, initRepo, tempDir, writeFiles } from './helpers/git-repo.js';
import path from 'node:path';

/** 仓储层样板：结构相同，只有 SQL 和名字不同 */
function repoFn(name: string, param: string, sql: string): string[] {
  return [
    `def ${name}(${param}, conn=None):`,
    '    with _use(conn) as c:',
    '        with c.cursor() as cur:',
    `            cur.execute("${sql}", (${param},))`,
    '            row = cur.fetchone()',
    '            return row[0] if row else None',
    '',
    '',
  ];
}

const EMAIL_SQL = 'SELECT email FROM app_user WHERE user_id = %s';

const REPO_PY = [
  'from contextlib import nullcontext',
  '',
  'pool = None',
  '',
  '',
  'def _use(conn):',
  '    return nullcontext(conn) if conn is not None else pool.connection()',
  '',
  '',
  ...repoFn('select_user_email', 'user_id', EMAIL_SQL),
  ...repoFn('save_order', 'order', 'INSERT INTO orders(payload) VALUES (%s) RETURNING id'),
].join('\n');

/** 新增的三个函数：真正的重复（函数体含 SQL 完全相同）、调用已有函数的包装、只有 SQL 不同的样板 */
const NEW_PY = [
  'from pkg import repo',
  'from pkg.repo import _use',
  '',
  '',
  ...repoFn('get_email_of_user', 'user_id', EMAIL_SQL),
  'def save_order(order, conn=None):',
  '    with _use(conn) as c:',
  '        with c.cursor() as cur:',
  '            cur.execute("SELECT pg_advisory_xact_lock(1)")',
  '            row = repo.save_order(order, c)',
  '            return row[0] if row else None',
  '',
  '',
  ...repoFn('count_paid_orders', 'org_id', 'SELECT count(*) FROM orders WHERE org_id = %s AND paid'),
].join('\n');

async function symbolsOf(files: Record<string, string>): Promise<SymbolRow[]> {
  const sources = Object.entries(files).map(([path, source]) => ({ path, source, isTest: path.startsWith('tests/'), isGenerated: false }));
  const { files: extracted } = await extractPythonFiles(sources);
  return extracted.flatMap((f) => f.symbols.map((s) => ({ ...s, snapshotId: 0 })));
}

function candidatesOf(findings: DuplicateFinding[], qualifiedName: string, path: string): string[] {
  const f = findings.find((x) => x.symbol.qualifiedName === qualifiedName && x.symbol.path === path);
  return f ? f.candidates.map((c) => `${c.symbol.path}:${c.symbol.qualifiedName}`) : [];
}

describe('similar building blocks', () => {
  it('splits snake_case and camelCase names', () => {
    expect([...nameTokens('_ensure_same_org')]).toEqual(['ensure', 'same', 'org']);
    expect([...nameTokens('loadHTTPConfig')]).toEqual(['load', 'http', 'config']);
  });

  it('reads the signature shape, ignoring self and the bare * marker', async () => {
    const syms = await symbolsOf({
      'm.py': ['class A:', '    def f(self, a, *, b: int = 1) -> None:', '        pass', '', '', 'def g(x, y):', '    return x', ''].join('\n'),
    });
    const by = new Map(syms.map((s) => [s.qualifiedName, s]));
    expect(signatureShape(by.get('A.f')!)).toEqual({ params: 2, returnsValue: false });
    expect(signatureShape(by.get('g')!)).toEqual({ params: 2, returnsValue: true });
  });

  it('finds near-identical sets through the LSH index and estimates Jaccard with MinHash', () => {
    const a = shingles(Array.from({ length: 60 }, (_, i) => `t${i}`));
    const b = shingles([...Array.from({ length: 58 }, (_, i) => `t${i}`), 'x', 'y']);
    const c = shingles(Array.from({ length: 60 }, (_, i) => `u${i}`));
    const index = new LshIndex<string>();
    index.add(minhash(a), 'a');
    index.add(minhash(c), 'c');
    expect([...index.query(minhash(b))]).toEqual(['a']);
    const [ma, mb] = [minhash(a), minhash(b)];
    const estimate = ma.filter((v, i) => v === mb[i]).length / ma.length;
    expect(Math.abs(estimate - jaccard(a, b))).toBeLessThan(0.15);
  });
});

describe('findDuplicates', () => {
  it('reports a duplicate body, keeps SQL-only boilerplate below the threshold, and drops a wrapper only because of the call', async () => {
    const syms = await symbolsOf({ 'pkg/repo.py': REPO_PY, 'pkg/new.py': NEW_PY });
    const newIds = syms.filter((s) => s.path === 'pkg/new.py' && s.kind === 'function').map((s) => s.id);
    const run = (linkedPairs: Set<string>) =>
      findDuplicates({ symbols: syms, queryIds: newIds, excludeIds: new Set(newIds), linkedPairs, minScore: 0.6 }).findings;

    const unlinked = run(new Set());
    const dup = unlinked.find((f) => f.symbol.qualifiedName === 'get_email_of_user')!;
    expect(dup.candidates[0]).toMatchObject({ symbol: { qualifiedName: 'select_user_email', path: 'pkg/repo.py' }, reasons: ['similar body (1.00)', 'same signature shape'] });
    // 0.5 * 1 + 0.3 * 名字切词 Jaccard（{get,email,of,user} 与 {select,user,email}：2/5）+ 0.2 * 1
    expect(dup.candidates[0]!.score).toBe(0.82);
    // 只有 SQL 不同：字符串字面量保留原文，函数体相似度不到 1，总分低于 0.6
    expect(candidatesOf(unlinked, 'count_paid_orders', 'pkg/new.py')).toEqual([]);
    // 没有调用关系时，包装函数会因为同名和相近的结构被报告
    expect(candidatesOf(unlinked, 'save_order', 'pkg/new.py')).toEqual(['pkg/repo.py:save_order']);

    const wrapper = syms.find((s) => s.path === 'pkg/new.py' && s.name === 'save_order')!;
    const original = syms.find((s) => s.path === 'pkg/repo.py' && s.name === 'save_order')!;
    const pair = [wrapper.id, original.id].sort().join('\0');
    const linked = run(new Set([pair]));
    expect(candidatesOf(linked, 'save_order', 'pkg/new.py')).toEqual([]);
    expect(candidatesOf(linked, 'get_email_of_user', 'pkg/new.py')).toEqual(['pkg/repo.py:select_user_email']);
  });

  it('skips functions shorter than 3 body lines and test code in the regular rule', async () => {
    const syms = await symbolsOf({
      'a.py': ['def short_a(x):', '    return x + 1', ''].join('\n'),
      'b.py': ['def short_b(x):', '    return x + 1', ''].join('\n'),
      'tests/test_c.py': REPO_PY,
      'd.py': REPO_PY,
    });
    const { findings } = findDuplicates({ symbols: syms, linkedPairs: new Set(), minScore: 0.6 });
    expect(findings.flatMap((f) => [f.symbol, ...f.candidates.map((c) => c.symbol)]).filter((s) => s.name.startsWith('short') || s.isTest)).toEqual([]);
  });

  it('reports each pair once in a full scan, at most 3 candidates per function', async () => {
    const copies = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`m${i}.py`, repoFn('select_user_email', 'user_id', EMAIL_SQL).join('\n')]));
    const syms = await symbolsOf(copies);
    const { findings, stats } = findDuplicates({ symbols: syms, linkedPairs: new Set(), minScore: 0.6 });
    expect(findings[0]!.candidates).toHaveLength(3);
    const pairs = findings.flatMap((f) => f.candidates.map((c) => [f.symbol.path, c.symbol.path].sort().join('-')));
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(pairs.length).toBe(10);
    expect(stats.queries).toBe(5);
  });

  it('switches to the LSH index when many functions are queried, with the same duplicates found', async () => {
    const extra = Array.from({ length: EXACT_BODY_QUERY_MAX }, (_, i) => [`def helper_${i}(v):`, `    w = v * ${i}`, `    w = w + ${i}`, '    return w', ''].join('\n')).join('\n');
    const syms = await symbolsOf({ 'pkg/repo.py': REPO_PY, 'pkg/new.py': NEW_PY, 'pkg/extra.py': extra });
    const idsIn = (file: string) => syms.filter((s) => s.path === file && s.kind === 'function').map((s) => s.id);
    const run = (queryIds: string[]) => findDuplicates({ symbols: syms, queryIds, excludeIds: new Set(queryIds), linkedPairs: new Set(), minScore: 0.6 });
    const lshAdd = vi.spyOn(LshIndex.prototype, 'add');
    try {
      const few = run(idsIn('pkg/new.py'));
      expect(lshAdd).not.toHaveBeenCalled();
      const many = run([...idsIn('pkg/new.py'), ...idsIn('pkg/extra.py')]);
      expect(many.stats.queries).toBeGreaterThan(EXACT_BODY_QUERY_MAX);
      expect(lshAdd).toHaveBeenCalled();
      expect(candidatesOf(many.findings, 'get_email_of_user', 'pkg/new.py')).toEqual(candidatesOf(few.findings, 'get_email_of_user', 'pkg/new.py'));
      expect(candidatesOf(many.findings, 'get_email_of_user', 'pkg/new.py')).toEqual(['pkg/repo.py:select_user_email']);
    } finally {
      lshAdd.mockRestore();
    }
  });
});

/** 已改为调用公共函数的 1 行版本 */
const WRAPPED = ['from pkg.common import select_scalar', '', '', 'def select_user_org_id(user_id: int, conn=None) -> int | None:', '    return select_scalar("app_user", "org_id", "user_id", user_id, conn)', ''].join('\n');
/** 还是内联 SQL 的旧实现 */
const INLINE = [
  'def select_user_org_id(user_id: int, conn=None) -> int | None:',
  '    with _use(conn) as c:',
  '        with c.cursor() as cur:',
  '            cur.execute("SELECT org_id FROM app_user WHERE user_id = %s", (user_id,))',
  '            row = cur.fetchone()',
  '            return row[0] if row else None',
  '',
].join('\n');

describe('same-name duplicate rule', () => {
  async function scan(files: Record<string, string>, link?: [string, string]) {
    const syms = await symbolsOf(files);
    const linked = new Set<string>();
    if (link) {
      const id = (p: string) => syms.find((s) => s.path === p && s.name === 'select_user_org_id')!.id;
      linked.add([id(link[0]), id(link[1])].sort().join('\0'));
    }
    return findDuplicates({ symbols: syms, linkedPairs: linked, minScore: 0.6 }).findings;
  }

  it('reports a 1-line wrapper version and an inline-SQL version with the same name and signature shape', async () => {
    const findings = await scan({ 'lease/repo.py': WRAPPED, 'usage/repo.py': INLINE });
    expect(findings).toHaveLength(1);
    const [f] = findings;
    expect([f!.symbol.path, f!.candidates[0]!.symbol.path].sort()).toEqual(['lease/repo.py', 'usage/repo.py']);
    // 分数照常按公式：函数体几乎不相似，0.3 * 名字 + 0.2 * 形状，低于 0.6 也报告
    expect(f!.candidates[0]).toMatchObject({ reasons: ['same-name duplicate'], score: 0.5 });
  });

  it('does not report the same name with a different signature shape', async () => {
    const otherShape = INLINE.replace('(user_id: int, conn=None)', '(user_id: int)');
    expect(await scan({ 'lease/repo.py': WRAPPED, 'usage/repo.py': otherShape })).toEqual([]);
  });

  it('does not report same-name definitions in the same file', async () => {
    expect(await scan({ 'lease/repo.py': WRAPPED + '\n\n' + WRAPPED.split('\n').slice(3).join('\n') })).toEqual([]);
  });

  it('does not report the pair when one calls the other', async () => {
    expect(await scan({ 'lease/repo.py': WRAPPED, 'usage/repo.py': INLINE }, ['lease/repo.py', 'usage/repo.py'])).toEqual([]);
  });

  it('keeps same-name candidates first within the 3-candidate limit', async () => {
    const files: Record<string, string> = { 'lease/repo.py': WRAPPED, 'usage/repo.py': INLINE };
    // 4 个函数体相同、名字相近的函数，常规分数都比同名重复的 0.5 高
    for (let i = 0; i < 4; i++) files[`x${i}.py`] = INLINE.replace('select_user_org_id', `select_user_org_id_v${i}`);
    const syms = await symbolsOf(files);
    const usage = syms.find((s) => s.path === 'usage/repo.py' && s.name === 'select_user_org_id')!;
    const { findings } = findDuplicates({ symbols: syms, queryIds: [usage.id], linkedPairs: new Set(), minScore: 0.6 });
    const c = findings[0]!.candidates;
    expect(c).toHaveLength(3);
    expect(c[0]).toMatchObject({ symbol: { path: 'lease/repo.py' }, reasons: ['same-name duplicate'], score: 0.5 });
    expect(c[1]!.score).toBeGreaterThan(0.5);
  });
});

describe('review step 8: duplicates', () => {
  it('reports the duplicate of an existing function and excludes the wrapper that calls it', async () => {
    const repo = initRepo({ 'pkg/__init__.py': '', 'pkg/repo.py': REPO_PY });
    writeFiles(repo, { 'pkg/new.py': NEW_PY });
    commitAll(repo, 'add new.py');
    const config = await loadConfig(repo, { dataDir: tempDir('ci-data-'), env: {} });
    const layout = await initDataDir(config.dataDir);
    const store = new Store(layout.dbPath);
    try {
      const report = await runReview({ repo, store, layout, config, head: 'HEAD', noLlm: true });
      expect(report.warnings.filter((w) => w.code === 'resolver_failed')).toEqual([]);
      expect(report.duplicates.map((f) => f.symbol.qualifiedName)).toEqual(['get_email_of_user']);
      expect(candidatesOf(report.duplicates, 'get_email_of_user', 'pkg/new.py')).toEqual(['pkg/repo.py:select_user_email']);
    } finally {
      store.close();
    }
  }, 120_000);
});

describe('similarToCode', () => {
  /** 把符号写进一个新快照，返回 store 和快照 id */
  async function storeWith(files: Record<string, string>): Promise<{ store: Store; snapshotId: number }> {
    const store = new Store(path.join(tempDir('ci-similar-code-'), 'index.db'));
    const snap = store.createSnapshot('commit', 'x', 'x');
    store.insertSymbols((await symbolsOf(files)).map((s) => ({ ...s, snapshotId: snap.id })));
    return { store, snapshotId: snap.id };
  }

  const BODY_ONLY = [
    'with _use(conn) as c:',
    '    with c.cursor() as cur:',
    `        cur.execute("${EMAIL_SQL}", (user_id,))`,
    '        row = cur.fetchone()',
    '        return row[0] if row else None',
  ].join('\n');

  it('scores a body-only snippet without the name and never applies the same-name rule to it', async () => {
    const { store, snapshotId } = await storeWith({ 'pkg/repo.py': REPO_PY, 'pkg/other.py': 'def snippet():\n    return 1\n' });
    try {
      const r = await similarToCode(store, snapshotId, BODY_ONLY, { minScore: 0.6 });
      expect(r.queries.map((q) => q.name)).toEqual(['snippet']);
      const c = r.findings[0]!.candidates;
      expect(c[0]!.symbol).toMatchObject({ path: 'pkg/repo.py', name: 'select_user_email' });
      expect(c.map((x) => x.symbol.path)).not.toContain('pkg/other.py');
      // 名字不计分，函数体和签名形状按 5:2 归一：(0.5 * 1 + 0.2 * 0.5) / 0.7
      expect(c[0]).toMatchObject({ score: 0.857, reasons: ['similar body (1.00)'] });
    } finally {
      store.close();
    }
  });

  it('keeps the name rules for a snippet that defines a named function', async () => {
    const { store, snapshotId } = await storeWith({ 'lease/repo.py': WRAPPED });
    try {
      const r = await similarToCode(store, snapshotId, INLINE, { minScore: 0.6 });
      expect(r.findings[0]!.candidates[0]).toMatchObject({ symbol: { path: 'lease/repo.py' }, reasons: ['same-name duplicate'], score: 0.5 });
    } finally {
      store.close();
    }
  });
});

describe('Go functions', () => {
  const MODULES = new Map([['', 'example.com/shop']]);

  async function goSymbolsOf(files: Record<string, string>): Promise<SymbolRow[]> {
    const sources = Object.entries(files).map(([p, source]) => ({ path: p, source, language: 'go' as const, isTest: false, isGenerated: false }));
    const { files: extracted } = await extractFiles(sources, { goModules: MODULES });
    return extracted.flatMap((f) => f.symbols.map((s) => ({ ...s, snapshotId: 0 })));
  }

  /** 结构相同、只有名字和字段不同的两个查询函数，另有一个结构不同的函数 */
  const lookup = (name: string, field: string) => [
    `func ${name}(db *sql.DB, id int) (string, error) {`,
    `\trow := db.QueryRow("SELECT ${field} FROM users WHERE id = ?", id)`,
    '\tvar v string',
    '\tif err := row.Scan(&v); err != nil {',
    '\t\treturn "", err',
    '\t}',
    '\treturn v, nil',
    '}',
    '',
  ].join('\n');
  const USERS = ['package users', '', 'import "database/sql"', '', lookup('EmailOf', 'email'), [
    'func Total(items []int) int {', '\tsum := 0', '\tfor _, it := range items {', '\t\tsum += it', '\t}', '\treturn sum', '}', '',
  ].join('\n')].join('\n');
  const ACCOUNTS = ['package accounts', '', 'import "database/sql"', '', lookup('PhoneOf', 'phone')].join('\n');

  it('reads the Go signature shape without the receiver, with grouped params and multiple results', async () => {
    const syms = await goSymbolsOf({
      'm/m.go': [
        'package m', '', 'type S struct{}', '', 'type R interface {', '\tFind(id int) (*S, error)', '}', '',
        'func (s *S) Do(a, b int, opts ...string) (int, error) {', '\treturn 0, nil', '}', '',
        'func Map[K comparable, V any](m map[K]V, f func(K) V) {', '}', '',
      ].join('\n'),
    });
    const by = new Map(syms.map((s) => [s.name, s]));
    expect(signatureShape(by.get('Do')!)).toEqual({ params: 3, returnsValue: true });
    expect(signatureShape(by.get('Map')!)).toEqual({ params: 2, returnsValue: false });
    expect(signatureShape(by.get('Find')!)).toEqual({ params: 1, returnsValue: true });
  });

  it('ranks the structurally identical Go function first and never compares Go with Python', async () => {
    const syms = [
      ...(await goSymbolsOf({ 'users/users.go': USERS, 'accounts/accounts.go': ACCOUNTS })),
      ...(await symbolsOf({ 'pkg/repo.py': REPO_PY })),
    ];
    const q = syms.find((s) => s.name === 'EmailOf')!;
    const { findings } = findDuplicates({ symbols: syms, queryIds: [q.id], linkedPairs: new Set(), minScore: 0.3 });
    const c = findings[0]!.candidates;
    expect(c[0]!.symbol).toMatchObject({ path: 'accounts/accounts.go', qualifiedName: 'example.com/shop/accounts.PhoneOf' });
    expect(c.every((x) => x.symbol.path.endsWith('.go'))).toBe(true);
  });

  it('does not treat String() on different types, New() in different packages or interface methods as same-name duplicates', async () => {
    const pkg = (name: string, type: string) => [
      `package ${name}`, '', `type ${type} struct{ n int }`, '',
      `func New() *${type} {`, `\treturn &${type}{}`, '}', '',
      `func (x ${type}) String() string {`, '\treturn "x"', '}', '',
      'func main() {', '}', '',
      'type Stringer interface {', '\tString() string', '}', '',
      'func Helper(n int) int {', '\treturn n + 1', '}', '',
    ].join('\n');
    const syms = await goSymbolsOf({ 'a/a.go': pkg('a', 'A'), 'b/b.go': pkg('b', 'B') });
    const { findings } = findDuplicates({ symbols: syms, linkedPairs: new Set(), minScore: 0.99 });
    const sameName = findings.flatMap((f) => f.candidates.filter((c) => c.reasons.includes('same-name duplicate')).map(() => f.symbol.name));
    // 只有普通函数 Helper 按同名重复报告
    expect(sameName).toEqual(['Helper']);
  });

  /** 每个候选的「查询名 -> 候选所在文件」和理由 */
  function reasonList(findings: DuplicateFinding[]): string[] {
    return findings.flatMap((f) => f.candidates.map((c) => `${f.symbol.path}#${f.symbol.name} -> ${c.symbol.path}: ${c.reasons.join(', ')}`));
  }

  it('does not count the funcN names of handler literals as same-name duplicates or similar names', async () => {
    const handlerPkg = (name: string, body: string[]) => [
      `package ${name}`, '', 'import "net/http"', '',
      'func Setup() {', '\thttp.HandleFunc("/x", func(w http.ResponseWriter, r *http.Request) {', ...body, '\t})', '}', '',
    ].join('\n');
    const syms = await goSymbolsOf({
      'a/a.go': handlerPkg('a', ['\t\tw.WriteHeader(200)', '\t\tw.Write([]byte("a"))', '\t\treturn']),
      'b/b.go': handlerPkg('b', ['\t\tif r.Method != "GET" {', '\t\t\tpanic(r.URL.Path)', '\t\t}']),
    });
    expect(syms.filter((s) => s.name === 'func1')).toHaveLength(2);
    const { findings } = findDuplicates({ symbols: syms, linkedPairs: new Set(), minScore: 0 });
    const lines = reasonList(findings).filter((l) => l.includes('#func1'));
    expect(lines.filter((l) => /same-name duplicate|same name/.test(l))).toEqual([]);
  });

  it('counts only same-name functions in different packages, never methods or same-package build-tag variants', async () => {
    const variant = (pkg: string) => [
      `package ${pkg}`, '', 'type File struct{ fd int }', '',
      'func Open(n int) int {', '\treturn n', '}', '',
      'func (f File) Close() error {', '\treturn nil', '}', '',
    ].join('\n');
    const other = ['package p', '', 'func Open(n int) int {', '\treturn n + 1', '}', '', 'func (f File) Close() error {', '\treturn nil', '}', ''].join('\n');
    const syms = await goSymbolsOf({ 'p/x_linux.go': variant('p'), 'p/x_windows.go': other, 'q/q.go': variant('q') });
    const { findings } = findDuplicates({ symbols: syms, linkedPairs: new Set(), minScore: 0.99 });
    const sameName = reasonList(findings).filter((l) => l.includes('same-name duplicate')).map((l) => l.split(':')[0]);
    // p 里两个文件之间的 Open 是构建标签变体；q 和 p 之间的 Open 是重复；File.Close 是方法，同包、跨包都不算
    expect(sameName.sort()).toEqual(['p/x_linux.go#Open -> q/q.go', 'p/x_windows.go#Open -> q/q.go']);
  });

  it('finds Go functions for a Go snippet, with or without a package clause', async () => {
    const store = new Store(path.join(tempDir('ci-similar-go-'), 'index.db'));
    const snap = store.createSnapshot('commit', 'x', 'x');
    store.insertSymbols([...(await goSymbolsOf({ 'users/users.go': USERS })), ...(await symbolsOf({ 'pkg/repo.py': REPO_PY }))].map((s) => ({ ...s, snapshotId: snap.id })));
    try {
      const named = await similarToCode(store, snap.id, `import "database/sql"\n\n${lookup('AddressOf', 'address')}`, { minScore: 0.6, language: 'go' });
      expect(named.queries.map((q) => q.path)).toEqual(['<snippet>/snippet.go']);
      expect(named.findings[0]!.candidates[0]!.symbol).toMatchObject({ path: 'users/users.go', name: 'EmailOf' });
      const body = lookup('X', 'address').split('\n').slice(1, -2).join('\n');
      // 匿名片段没有参数和返回值，签名形状不计分，阈值放低
      const anonymous = await similarToCode(store, snap.id, body, { minScore: 0.5, language: 'go' });
      expect(anonymous.queries.map((q) => q.name)).toEqual(['snippet']);
      expect(anonymous.findings[0]!.candidates.map((c) => c.symbol.path)).toEqual(['users/users.go']);
    } finally {
      store.close();
    }
  });
});

describe('Rust functions', () => {
  async function rustSymbolsOf(files: Record<string, string>): Promise<SymbolRow[]> {
    const sources = Object.entries(files).map(([p, source]) => ({ path: p, source, language: 'rust' as const, isTest: false, isGenerated: false }));
    const { files: extracted } = await extractFiles(sources);
    return extracted.flatMap((f) => f.symbols.map((s) => ({ ...s, snapshotId: 0 })));
  }

  /** 结构相同、只有名字和字段不同的查询函数 */
  const lookup = (name: string, field: string) => [
    `pub fn ${name}(conn: &Connection, id: i64) -> Result<String, Error> {`,
    `    let mut stmt = conn.prepare("SELECT ${field} FROM users WHERE id = ?")?;`,
    '    let v: String = stmt.query_row([id], |row| row.get(0))?;',
    '    if v.is_empty() {',
    '        return Err(Error::Empty);',
    '    }',
    '    Ok(v)',
    '}',
    '',
  ].join('\n');
  const TOTAL = ['pub fn total(items: &[i64]) -> i64 {', '    let mut sum = 0;', '    for it in items {', '        sum += it;', '    }', '    sum', '}', ''].join('\n');
  const USERS = ['use rusqlite::Connection;', '', lookup('email_of', 'email'), TOTAL].join('\n');
  const ACCOUNTS = ['use rusqlite::Connection;', '', lookup('phone_of', 'phone')].join('\n');

  it('reads the Rust signature shape without self, with generics, lifetimes and nested generic arguments', async () => {
    const syms = await rustSymbolsOf({
      'm/m.rs': [
        'pub struct S;', '',
        'pub trait R {', '    fn find(&self, id: u64) -> Option<S>;', '}', '',
        'impl S {',
        "    pub fn r#do<'a, F: Fn(u8) -> u8>(&'a mut self, a: &'a str, m: HashMap<String, Vec<u8>>, f: F) -> Result<(), String> where F: Clone {",
        '        Ok(())', '    }',
        '    fn unit(self: Box<Self>) -> () {}',
        '    fn none(&self) {}',
        '}', '',
        'pub async fn top(x: (u8, u8)) -> impl Fn(u8) -> u8 {', '    move |a| a', '}', '',
      ].join('\n'),
    });
    const by = new Map(syms.map((s) => [s.name, s]));
    expect(signatureShape(by.get('do')!)).toEqual({ params: 3, returnsValue: true });
    expect(signatureShape(by.get('unit')!)).toEqual({ params: 0, returnsValue: false });
    expect(signatureShape(by.get('none')!)).toEqual({ params: 0, returnsValue: false });
    expect(signatureShape(by.get('find')!)).toEqual({ params: 1, returnsValue: true });
    expect(signatureShape(by.get('top')!)).toEqual({ params: 1, returnsValue: true });
  });

  it('ranks the structurally identical Rust function first and never compares Rust with Go or Python', async () => {
    const syms = [
      ...(await rustSymbolsOf({ 'users/users.rs': USERS, 'accounts/accounts.rs': ACCOUNTS })),
      ...(await symbolsOf({ 'pkg/repo.py': REPO_PY })),
    ];
    const q = syms.find((s) => s.name === 'email_of')!;
    const { findings } = findDuplicates({ symbols: syms, queryIds: [q.id], linkedPairs: new Set(), minScore: 0.3 });
    const c = findings[0]!.candidates;
    expect(c[0]!.symbol).toMatchObject({ path: 'accounts/accounts.rs', name: 'phone_of' });
    expect(c.every((x) => x.symbol.path.endsWith('.rs'))).toBe(true);
  });

  it('never counts methods (new, fmt, trait methods), conventional names or closures as same-name duplicates', async () => {
    const module = (type: string) => [
      `pub struct ${type} { n: i32 }`, '',
      `impl ${type} {`, '    pub fn new() -> Self {', `        ${type} { n: 0 }`, '    }', '}', '',
      `impl std::fmt::Display for ${type} {`,
      '    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {', '        write!(f, "x")', '    }', '}', '',
      'pub trait Named {', '    fn name(', '        &self,', '        a: i32,', '        b: i32,', '    ) -> String;', '}', '',
      'fn main() {', '}', '',
      'pub fn from(n: i32) -> i32 {', '    n', '}', '',
      'pub fn helper(n: i32) -> i32 {', '    n + 1', '}', '',
    ].join('\n');
    const syms = await rustSymbolsOf({ 'a/a.rs': module('A'), 'b/b.rs': module('B') });
    const sameNameOf = (symbols: SymbolRow[]) =>
      findDuplicates({ symbols, linkedPairs: new Set(), minScore: 0.99 }).findings
        .flatMap((f) => f.candidates.filter((c) => c.reasons.includes('same-name duplicate')).map(() => f.symbol.name));
    // 只有普通函数 helper 按同名重复报告
    expect(sameNameOf(syms)).toEqual(['helper']);
    // trait 里没有函数体的方法不参与任何比较
    const all = findDuplicates({ symbols: syms, linkedPairs: new Set(), minScore: 0 }).findings;
    expect(all.filter((f) => f.symbol.name === 'name' || f.candidates.some((c) => c.symbol.name === 'name'))).toEqual([]);
    // 闭包符号（closureN）的编号名字不算同名
    const closures = syms.map((s) => (s.name === 'helper' ? { ...s, name: 'closure1', qualifiedName: s.qualifiedName.replace(/helper$/, 'closure1') } : s));
    expect(sameNameOf(closures)).toEqual([]);
  });

  it('counts same-name functions only across module paths', async () => {
    const fn = ['pub fn open(n: i32) -> i32 {', '    n', '}', ''].join('\n');
    const crates = rustCratesFromManifests({
      manifests: new Map([['Cargo.toml', '[package]\nname = "app"\nversion = "0.1.0"\n']]),
      files: ['Cargo.toml', 'src/lib.rs', 'src/main.rs', 'src/x.rs', 'src/bin/tool.rs'],
    });
    const sources = { 'src/lib.rs': fn, 'src/main.rs': fn, 'src/x.rs': fn };
    const { files: extracted } = await extractFiles(
      Object.entries(sources).map(([p, source]) => ({ path: p, source, language: 'rust' as const, isTest: false, isGenerated: false })),
      { goModules: new Map(), rustCrates: crates },
    );
    const syms = extracted.flatMap((f) => f.symbols.map((s) => ({ ...s, snapshotId: 0 })));
    const { findings } = findDuplicates({ symbols: syms, linkedPairs: new Set(), minScore: 0.99 });
    const pairs = findings.flatMap((f) => f.candidates.filter((c) => c.reasons.includes('same-name duplicate')).map((c) => `${f.symbol.qualifiedName} -> ${c.symbol.qualifiedName}`));
    // lib.rs 是 `app`，main.rs 是 bin `app`：模块路径相同，不算；x.rs 是 `app::x`
    expect(pairs.sort()).toEqual(['app::open -> app::x::open', 'app::open -> app::x::open']);
  });

  it('finds Rust functions for a Rust snippet, named or body-only', async () => {
    const store = new Store(path.join(tempDir('ci-similar-rust-'), 'index.db'));
    const snap = store.createSnapshot('commit', 'x', 'x');
    store.insertSymbols([...(await rustSymbolsOf({ 'users/users.rs': USERS })), ...(await symbolsOf({ 'pkg/repo.py': REPO_PY }))].map((s) => ({ ...s, snapshotId: snap.id })));
    try {
      const named = await similarToCode(store, snap.id, lookup('address_of', 'address'), { minScore: 0.6, language: 'rust' });
      expect(named.queries.map((q) => q.path)).toEqual(['<snippet>/snippet.rs']);
      expect(named.findings[0]!.candidates[0]!.symbol).toMatchObject({ path: 'users/users.rs', name: 'email_of' });
      const body = lookup('x', 'address').split('\n').slice(1, -2).join('\n');
      const anonymous = await similarToCode(store, snap.id, body, { minScore: 0.5, language: 'rust' });
      expect(anonymous.queries.map((q) => q.name)).toEqual(['snippet']);
      expect(anonymous.findings[0]!.candidates.map((c) => c.symbol.path)).toEqual(['users/users.rs']);
    } finally {
      store.close();
    }
  });
});
