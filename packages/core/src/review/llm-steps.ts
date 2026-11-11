import { runIntentCheck, docFirstLine, type IntentItem } from '../intent/index.js';
import { createLlmClient, type LlmClient } from '../llm/index.js';
import { log } from '../log.js';
import type { SnapshotRow } from '../model/types.js';
import type { DuplicateFinding, FileChange, IntentFinding, ReviewReport, SymbolRef, Warning } from '../report/types.js';
import { isCheckedFunction, similarInSnapshot } from '../similar/index.js';
import { moduleOf } from './assemble.js';
import { symbolRef } from './impact.js';
import type { SymbolDiff } from './symbol-diff.js';
import type { ReviewOptions } from './versions.js';

/** 第 8 步：对 added 和 moved 的非测试函数找重复实现（短函数只走同名重复规则），本次改动的符号不作为候选 */
export function findReviewDuplicates(opts: ReviewOptions, head: SnapshotRow | undefined, diffs: SymbolDiff[]): DuplicateFinding[] {
  if (!head) return [];
  const queryIds = diffs.filter((d) => (d.change === 'added' || d.change === 'moved') && isCheckedFunction(d.head!)).map((d) => d.head!.id);
  if (queryIds.length === 0) {
    log.info('similar_skipped', { reason: 'no added or moved non-test functions' });
    return [];
  }
  const excludeIds = new Set(diffs.flatMap((d) => (d.head ? [d.head.id] : [])));
  return similarInSnapshot(opts.store, head.id, { queryIds, excludeIds, minScore: opts.config.similarMinScore }).findings;
}

/** 每个进程对同一个 provider + 模型只提示一次 */
const noticed = new Set<string>();

function notifyOnce(opts: ReviewOptions, client: LlmClient): void {
  const id = `${client.provider}\0${client.model}`;
  if (noticed.has(id)) return;
  noticed.add(id);
  const message = `sending a structural summary of the change (no function bodies) to ${client.provider} (${client.model})`;
  if (opts.onLlmNotice) opts.onLlmNotice(message);
  else log.info('llm_notice', { provider: client.provider, model: client.model });
}

type ClientResult = { client: LlmClient } | { warning: Warning };

function llmClient(opts: ReviewOptions): ClientResult | undefined {
  if (opts.llmClient) return { client: opts.llmClient };
  const problem = opts.config.llmProblem;
  if (problem) return { warning: { code: 'llm_not_configured', level: 'warning', message: `intent check skipped: invalid LLM configuration: ${problem}` } };
  if (!opts.config.llm) return undefined;
  try {
    return { client: createLlmClient(opts.config.llm) };
  } catch (err) {
    return { warning: { code: 'llm_not_configured', level: 'info', message: `intent check skipped: ${(err as Error).message}` } };
  }
}

function intentItems(diffs: SymbolDiff[], moduleDepth: number): { items: IntentItem[]; refs: Map<string, SymbolRef> } {
  const items: IntentItem[] = [];
  const refs = new Map<string, SymbolRef>();
  for (const d of diffs) {
    const s = d.change === 'removed' ? d.base! : d.head!;
    items.push({ key: s.symbolKey, module: moduleOf(s.path, moduleDepth), change: d.change, displaySignature: s.displaySignature, docLine: docFirstLine(s.docstring) });
    refs.set(s.symbolKey, symbolRef(s));
  }
  return { items, refs };
}

export interface IntentStepResult {
  intentCheck?: IntentFinding[];
  warnings: Warning[];
}

const info = (code: string, message: string): IntentStepResult => ({ warnings: [{ code, level: 'info', message }] });

/** 第 9 步：配置了 LLM、没有 --no-llm、有意图文本时做意图偏离检测；跳过的原因写进 warnings */
export async function checkIntent(opts: ReviewOptions, intent: ReviewReport['intent'], diffs: SymbolDiff[], files: FileChange[]): Promise<IntentStepResult> {
  if (opts.noLlm) {
    log.info('intent_skipped', { reason: 'no_llm' });
    return info('llm_disabled', 'intent check skipped: --no-llm');
  }
  const c = llmClient(opts);
  if (!c) {
    log.info('intent_skipped', { reason: 'llm_not_configured' });
    return info('llm_not_configured', 'intent check skipped: no LLM configured (set llm in codeinsight.config.json or CODEINSIGHT_LLM_PROVIDER)');
  }
  if ('warning' in c) {
    log.info('intent_skipped', { reason: 'llm_not_configured', detail: c.warning.message });
    return { warnings: [c.warning] };
  }
  if (!intent?.text.trim()) {
    log.info('intent_skipped', { reason: 'no_intent_text' });
    return { warnings: [{ code: 'intent_missing', level: 'warning', message: 'intent check skipped: no intent text (use --intent or --intent-file when reviewing the working tree)' }] };
  }
  const { items, refs } = intentItems(diffs, opts.config.moduleDepth);
  const addedFiles = files.filter((f) => f.status === 'added').map((f) => f.path);
  const r = await runIntentCheck({
    intentText: intent.text, items, addedFiles, refs, client: c.client, cacheDir: opts.layout.llmCacheDir,
    onBeforeSend: () => notifyOnce(opts, c.client),
  });
  return { ...(r.findings ? { intentCheck: r.findings } : {}), warnings: r.warnings };
}
