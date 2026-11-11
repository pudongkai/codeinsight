import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildStructureSummary, initDataDir, loadConfig, runIntentCheck, runReview, Store } from '../src/index.js';
import type { IntentItem, LlmClient, LlmRequest, ReviewOptions, ReviewReport, SymbolRef } from '../src/index.js';
import { commitAll, initRepo, tempDir, writeFiles } from './helpers/git-repo.js';

/** 假的 LLM：按顺序返回预设的回复，记录收到的请求 */
class FakeLlm implements LlmClient {
  readonly provider = 'fake';
  readonly calls: LlmRequest[] = [];
  constructor(private readonly replies: (string | Error)[], readonly model = 'fake-model') {}
  complete(req: LlmRequest): Promise<string> {
    this.calls.push(structuredClone(req));
    const r = this.replies[Math.min(this.calls.length - 1, this.replies.length - 1)]!;
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  }
}

const ITEMS: IntentItem[] = [
  { key: 'pkg/a.py#function#login#', module: 'pkg', change: 'modified', displaySignature: '(user)', docLine: 'Log a user in.' },
  { key: 'pkg/a.py#function#lock_after_failures#', module: 'pkg', change: 'added', displaySignature: '(user, n=5)', docLine: null },
  { key: 'admin/org.py#function#create_org#', module: 'admin', change: 'added', displaySignature: '(name) -> int', docLine: 'Create an organisation.' },
];

function refs(items: IntentItem[]): Map<string, SymbolRef> {
  return new Map(items.map((i) => {
    const [path, kind, qualifiedName] = i.key.split('#') as [string, string, string];
    return [i.key, { key: i.key, id: i.key, kind, name: qualifiedName, qualifiedName, path, startLine: 1, isTest: false }];
  }));
}

const GOOD_REPLY = JSON.stringify({
  groups: [
    { verdict: 'mentioned', summary: 'Login lockout', symbols: ['pkg/a.py#function#login#', 'pkg/a.py#function#lock_after_failures#'] },
    { verdict: 'unmentioned', summary: 'New org management', symbols: ['admin/org.py#function#create_org#', 'admin/org.py#function#made_up#'], modules: ['admin', 'nowhere'] },
    { verdict: 'unclear', summary: 'Only unknown keys', symbols: ['x.py#function#ghost#'] },
  ],
});

function input(client: LlmClient, cacheDir = tempDir('ci-llm-cache-'), intentText = 'Lock accounts after 5 failed logins') {
  return { intentText, items: ITEMS, addedFiles: ['admin/org.py'], refs: refs(ITEMS), client, cacheDir };
}

describe('intent check with a fake LLM', () => {
  it('parses the groups and drops keys and modules that are not in the change list', async () => {
    const llm = new FakeLlm([GOOD_REPLY]);
    const r = await runIntentCheck(input(llm));
    expect(r.warnings).toEqual([]);
    expect(r.findings!.map((f) => ({ verdict: f.verdict, summary: f.summary, keys: f.symbols.map((s) => s.key), modules: f.modules }))).toEqual([
      { verdict: 'mentioned', summary: 'Login lockout', keys: ['pkg/a.py#function#login#', 'pkg/a.py#function#lock_after_failures#'], modules: ['pkg'] },
      { verdict: 'unmentioned', summary: 'New org management', keys: ['admin/org.py#function#create_org#'], modules: ['admin'] },
    ]);
  });

  it('sends only the structural summary: keys, change types, signatures, docstring first lines and added files', async () => {
    const llm = new FakeLlm([GOOD_REPLY]);
    await runIntentCheck(input(llm));
    const prompt = llm.calls[0]!.messages[0]!.content;
    expect(prompt).toContain('Lock accounts after 5 failed logins');
    expect(prompt).toContain('- [added] admin/org.py#function#create_org# (name) -> int — Create an organisation.');
    expect(prompt).toContain('## Added files\n- admin/org.py');
    expect(llm.calls[0]!.system).toContain('"groups"');
  });

  it('reuses the cached result for the same model, intent and summary', async () => {
    const cacheDir = tempDir('ci-llm-cache-');
    const first = new FakeLlm([GOOD_REPLY]);
    const a = await runIntentCheck(input(first, cacheDir));
    const second = new FakeLlm([new Error('must not be called')]);
    const b = await runIntentCheck(input(second, cacheDir));
    expect(second.calls).toHaveLength(0);
    expect(b).toMatchObject({ cached: true, findings: a.findings });
    expect(readdirSync(cacheDir).filter((f) => f.endsWith('.json'))).toHaveLength(1);

    const otherIntent = new FakeLlm([GOOD_REPLY]);
    await runIntentCheck(input(otherIntent, cacheDir, 'Something else'));
    const otherModel = new FakeLlm([GOOD_REPLY], 'another-model');
    await runIntentCheck(input(otherModel, cacheDir));
    expect([otherIntent.calls.length, otherModel.calls.length]).toEqual([1, 1]);
  });

  it('retries once with the reason when the reply is invalid, accepting fenced JSON', async () => {
    const llm = new FakeLlm(['Sure! Here are the groups.', '```json\n' + GOOD_REPLY + '\n```']);
    const r = await runIntentCheck(input(llm));
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(llm.calls[1]!.messages[2]!.content).toContain('not valid JSON');
    expect(r.findings).toHaveLength(2);
  });

  it('gives up with a warning after two invalid replies and does not cache them', async () => {
    const cacheDir = tempDir('ci-llm-cache-');
    const bad = JSON.stringify({ groups: [{ verdict: 'maybe', summary: 's', symbols: [] }] });
    const llm = new FakeLlm([bad]);
    const r = await runIntentCheck(input(llm, cacheDir));
    expect(llm.calls).toHaveLength(2);
    expect(r.findings).toBeUndefined();
    expect(r.warnings).toMatchObject([{ code: 'llm_invalid_response', level: 'warning', message: expect.stringContaining('verdict') }]);
    expect(readdirSync(cacheDir)).toEqual([]);
  });

  it('turns a request failure into an llm_failed warning without retrying', async () => {
    const llm = new FakeLlm([new Error('HTTP 529: overloaded')]);
    const r = await runIntentCheck(input(llm));
    expect(llm.calls).toHaveLength(1);
    expect(r.warnings).toMatchObject([{ code: 'llm_failed', message: expect.stringContaining('HTTP 529') }]);
  });

  it('truncates the summary by module when it exceeds the token budget', () => {
    const many: IntentItem[] = Array.from({ length: 40 }, (_, i) => ({
      key: `m${i % 4}/f.py#function#f${i}#`, module: `m${i % 4}`, change: 'added', displaySignature: '(a, b, c)', docLine: 'x'.repeat(100),
    }));
    const s = buildStructureSummary(many, [], 900);
    expect(s.truncatedModules.length).toBeGreaterThan(0);
    expect(s.includedKeys.size + s.omittedSymbols).toBe(40);
    for (const m of s.truncatedModules) expect(s.text).not.toContain(`## ${m}\n`);
  });
});

const V1: Record<string, string> = {
  'pkg/__init__.py': '',
  'pkg/auth.py': ['def login(user):', '    """Log a user in."""', "    return 'SECRET_BODY_MARKER'", ''].join('\n'),
};

async function reviewRepo(extra: Partial<ReviewOptions> & { configEnv?: NodeJS.ProcessEnv; working?: boolean } = {}): Promise<{ report: ReviewReport; cacheDir: string }> {
  const repo = initRepo(V1);
  writeFiles(repo, { 'pkg/auth.py': V1['pkg/auth.py']! + ['', '', 'def lock(user):', '    """Lock the account."""', '    user.locked = True', '    return user', ''].join('\n') });
  if (!extra.working) commitAll(repo, 'Lock accounts after failed logins');
  const config = await loadConfig(repo, { dataDir: tempDir('ci-data-'), env: extra.configEnv ?? {} });
  const layout = await initDataDir(config.dataDir);
  const store = new Store(layout.dbPath);
  try {
    const head = extra.working ? undefined : 'HEAD';
    return { report: await runReview({ repo, store, layout, config, head, ...extra }), cacheDir: layout.llmCacheDir };
  } finally {
    store.close();
  }
}

describe('review step 9: intent check', () => {
  it('completes without an LLM and adds llm_not_configured', async () => {
    const { report } = await reviewRepo();
    expect(report.intentCheck).toBeUndefined();
    expect(report.intent).toMatchObject({ source: 'commits' });
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'llm_not_configured' }));
    expect(report.modules.flatMap((m) => m.symbols).map((s) => `${s.change} ${s.qualifiedName}`)).toEqual(['added lock']);
  }, 60_000);

  it('skips the LLM with --no-llm even when one is configured', async () => {
    const llm = new FakeLlm([new Error('must not be called')]);
    const { report } = await reviewRepo({ llmClient: llm, noLlm: true });
    expect(llm.calls).toHaveLength(0);
    expect(report.intentCheck).toBeUndefined();
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'llm_disabled' }));
  }, 60_000);

  it('checks the commit messages against the change, notifies once before sending, and never sends function bodies', async () => {
    const reply = JSON.stringify({ groups: [{ verdict: 'mentioned', summary: 'Account lock', symbols: ['pkg/auth.py#function#lock#'] }] });
    const llm = new FakeLlm([reply], 'fake-review-model');
    const notices: string[] = [];
    const { report } = await reviewRepo({ llmClient: llm, onLlmNotice: (m) => notices.push(m) });
    expect(report.intentCheck).toMatchObject([{ verdict: 'mentioned', modules: ['pkg'], symbols: [{ key: 'pkg/auth.py#function#lock#', path: 'pkg/auth.py' }] }]);
    expect(notices).toEqual([expect.stringContaining('fake (fake-review-model)')]);
    const prompt = llm.calls[0]!.messages[0]!.content;
    expect(prompt).toContain('Lock accounts after failed logins');
    expect(prompt).toContain('[added] pkg/auth.py#function#lock# (user) — Lock the account.');
    expect(prompt).not.toContain('SECRET_BODY_MARKER');
    expect(prompt).not.toContain('user.locked');
  }, 60_000);

  it('uses --intent text for the working tree and warns when there is none', async () => {
    const reply = JSON.stringify({ groups: [{ verdict: 'unmentioned', summary: 'Lock', symbols: ['pkg/auth.py#function#lock#'] }] });
    const withIntent = await reviewRepo({ working: true, llmClient: new FakeLlm([reply]), intent: { source: 'arg', text: 'Refactor login' } });
    expect(withIntent.report.intent).toEqual({ source: 'arg', text: 'Refactor login' });
    expect(withIntent.report.intentCheck).toMatchObject([{ verdict: 'unmentioned' }]);
    const without = await reviewRepo({ working: true, llmClient: new FakeLlm([reply]) });
    expect(without.report.intentCheck).toBeUndefined();
    expect(without.report.warnings).toContainEqual(expect.objectContaining({ code: 'intent_missing' }));
  }, 60_000);

  it('reports a missing anthropic API key as llm_not_configured', async () => {
    const { report } = await reviewRepo({ configEnv: { CODEINSIGHT_LLM_PROVIDER: 'anthropic' } });
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'llm_not_configured', message: expect.stringContaining('API key') }));
  }, 60_000);
});
