import { extractPythonFile, getPythonParser } from '../extract/index.js';
import { log } from '../log.js';
import type { SymbolRow } from '../model/types.js';
import type { DuplicateFinding } from '../report/types.js';
import { symbolRef } from '../review/impact.js';
import type { Store } from '../store/db.js';
import {
  bodySimilarityOf,
  FUNCTION_KINDS,
  functionFeatures,
  isCheckedFunction,
  isSameNameDuplicate,
  nameSimilarity,
  shapeSimilarity,
  type FunctionFeatures,
} from './features.js';
import { LshIndex, minhash } from './minhash.js';
import { pushTo } from '../util/collections.js';

export { LshIndex, minhash, MINHASH_SIZE } from './minhash.js';
export { FUNCTION_KINDS, isCheckedFunction, isComparableFunction, isSameNameDuplicate, nameTokens, signatureShape, shapeSimilarity, MIN_BODY_LINES } from './features.js';

/** 函数体相似度达到这个值时，名字不像也作为候选 */
export const BODY_CANDIDATE_MIN = 0.5;
/** 名字切词后 Jaccard 达到这个值时作为候选 */
export const NAME_CANDIDATE_MIN = 0.6;
export const MAX_CANDIDATES = 3;
/** 查询函数不超过这个数时逐个精确算函数体相似度；更多时建 LSH 更快 */
export const EXACT_BODY_QUERY_MAX = 64;
const WEIGHTS = { body: 0.5, name: 0.3, shape: 0.2 };
/** 匿名片段没有名字可比，按函数体和签名形状原有的比例重新归一 */
const ANONYMOUS_WEIGHTS = { body: WEIGHTS.body / (WEIGHTS.body + WEIGHTS.shape), name: 0, shape: WEIGHTS.shape / (WEIGHTS.body + WEIGHTS.shape) };

export interface SimilarInput {
  /** 快照里的符号，需要带 norm_tokens */
  symbols: SymbolRow[];
  /** 要找重复实现的函数 id；不传时全库扫描，每对函数只报告一次 */
  queryIds?: string[];
  /** 不能作为候选的符号 id（审查时为本次改动的符号） */
  excludeIds?: Set<string>;
  /** 没有真实名字的查询函数（包装成函数的代码片段）：不计名字分，不走名字候选和同名重复规则 */
  anonymousIds?: Set<string>;
  /** 有直接调用或引用关系（任一方向）的符号对，`a\0b` 形式；这样的组合是透传或包装，不算重复 */
  linkedPairs: Set<string>;
  minScore: number;
  maxCandidates?: number;
}

export interface SimilarStats {
  queries: number;
  /** 名字或函数体命中、进入评分的组合数 */
  candidates: number;
  /** 因直接调用 / 引用、语言不同或已在别的组合里报告而去掉的组合数 */
  filtered: number;
  /** 评分达到阈值或符合同名重复规则的组合数（每个函数截断到最多 3 个之前） */
  aboveThreshold: number;
  /** 其中符合同名重复规则的组合数 */
  sameName: number;
  findings: number;
}

export interface SimilarResult {
  findings: DuplicateFinding[];
  stats: SimilarStats;
}

/**
 * 候选池上的索引：名字完全相同（含短函数，供同名重复规则）、名字切词（只含可常规比较的函数），
 * 以及按函数体找候选用的结构：全库扫描或查询函数较多时建 MinHash LSH；只查少量函数时不建，直接对可比较的函数算精确相似度。
 */
interface PoolIndex {
  byName: Map<string, FunctionFeatures[]>;
  byNameToken: Map<string, FunctionFeatures[]>;
  comparable: FunctionFeatures[];
  lsh?: LshIndex<FunctionFeatures>;
}

function buildIndex(pool: FunctionFeatures[], withLsh: boolean): PoolIndex {
  const index: PoolIndex = { byName: new Map(), byNameToken: new Map(), comparable: [], ...(withLsh ? { lsh: new LshIndex() } : {}) };
  for (const f of pool) {
    pushTo(index.byName, f.symbol.name, f);
    if (!f.comparable) continue;
    for (const t of f.nameTokens) pushTo(index.byNameToken, t, f);
    if (f.shingles.size === 0) continue;
    index.comparable.push(f);
    index.lsh?.add(minhash(f.shingles), f);
  }
  return index;
}

/** 函数体可能相似的候选：有 LSH 时取命中的桶，否则逐个精确计算，只留达到候选阈值的 */
function bodyCandidates(q: FunctionFeatures, index: PoolIndex): Iterable<FunctionFeatures> {
  if (q.shingles.size === 0) return [];
  if (index.lsh) return index.lsh.query(minhash(q.shingles));
  return index.comparable.filter((c) => bodySimilarityOf(q, c) >= BODY_CANDIDATE_MIN);
}

/** 名字相同、名字切词相似或函数体相似的候选；函数体相似度在评分时精确计算。短函数只查名字相同的，匿名片段只查函数体 */
function candidatesOf(q: FunctionFeatures, index: PoolIndex, anonymous: boolean): Set<FunctionFeatures> {
  const out = new Set<FunctionFeatures>(anonymous ? [] : (index.byName.get(q.symbol.name) ?? []));
  if (q.comparable) {
    if (!anonymous) {
      for (const t of q.nameTokens) {
        for (const c of index.byNameToken.get(t) ?? []) if (!out.has(c) && nameSimilarity(q, c) >= NAME_CANDIDATE_MIN) out.add(c);
      }
    }
    for (const c of bodyCandidates(q, index)) out.add(c);
  }
  out.delete(q);
  return out;
}

interface Scored {
  candidate: FunctionFeatures;
  score: number;
  reasons: string[];
  /** 符合同名重复规则：不受 minScore 限制，截断到 3 个时优先保留 */
  sameName: boolean;
}

/** 命中的各项；同名重复时名字和签名形状已由 `same-name duplicate` 说明 */
function reasonsOf(q: FunctionFeatures, c: FunctionFeatures, sims: { sameName: boolean; name: number; body: number; shape: number }): string[] {
  const reasons: string[] = [];
  if (sims.sameName) reasons.push('same-name duplicate');
  else if (sims.name === 1) reasons.push(q.symbol.name === c.symbol.name ? 'same name' : 'same name tokens');
  else if (sims.name >= NAME_CANDIDATE_MIN) reasons.push(`similar name (${sims.name.toFixed(2)})`);
  if (sims.body >= BODY_CANDIDATE_MIN) reasons.push(`similar body (${sims.body.toFixed(2)})`);
  if (sims.shape === 1 && !sims.sameName) reasons.push('same signature shape');
  return reasons;
}

/**
 * 既不符合同名重复规则、名字和函数体也都没命中候选条件（LSH 误命中、短函数的同名但形状不同）时返回 undefined。
 * 同名重复的 score 照常按公式计算。
 */
function score(q: FunctionFeatures, c: FunctionFeatures, anonymous: boolean): Scored | undefined {
  const sameName = !anonymous && isSameNameDuplicate(q, c);
  const name = anonymous ? 0 : nameSimilarity(q, c);
  const body = bodySimilarityOf(q, c);
  const regular = q.comparable && c.comparable && (name >= NAME_CANDIDATE_MIN || body >= BODY_CANDIDATE_MIN);
  if (!sameName && !regular) return undefined;
  const shape = shapeSimilarity(q.shape, c.shape);
  const reasons = reasonsOf(q, c, { sameName, name, body, shape });
  const w = anonymous ? ANONYMOUS_WEIGHTS : WEIGHTS;
  const total = w.body * body + w.name * name + w.shape * shape;
  return { candidate: c, score: Math.round(total * 1000) / 1000, reasons, sameName };
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

interface ScanContext {
  input: SimilarInput;
  index: PoolIndex;
  stats: SimilarStats;
  /** 全库扫描时已报告的组合 */
  reported?: Set<string>;
}

function findingFor(q: FunctionFeatures, ctx: ScanContext): DuplicateFinding | undefined {
  const scored: Scored[] = [];
  const anonymous = ctx.input.anonymousIds?.has(q.symbol.id) ?? false;
  for (const c of candidatesOf(q, ctx.index, anonymous)) {
    const key = pairKey(q.symbol.id, c.symbol.id);
    if (c.language !== q.language || ctx.input.linkedPairs.has(key) || ctx.reported?.has(key)) {
      ctx.stats.filtered++;
      continue;
    }
    ctx.stats.candidates++;
    const s = score(q, c, anonymous);
    if (s && (s.sameName || s.score >= ctx.input.minScore)) scored.push(s);
  }
  ctx.stats.aboveThreshold += scored.length;
  ctx.stats.sameName += scored.filter((s) => s.sameName).length;
  if (scored.length === 0) return undefined;
  const top = scored
    .sort((a, b) => Number(b.sameName) - Number(a.sameName) || b.score - a.score || a.candidate.symbol.symbolKey.localeCompare(b.candidate.symbol.symbolKey))
    .slice(0, ctx.input.maxCandidates ?? MAX_CANDIDATES);
  for (const s of top) ctx.reported?.add(pairKey(q.symbol.id, s.candidate.symbol.id));
  return {
    symbol: symbolRef(q.symbol),
    candidates: top.map((s) => ({ symbol: symbolRef(s.candidate.symbol), score: s.score, reasons: s.reasons })),
  };
}

/**
 * 找重复实现：候选为同语言、不在 excludeIds 里的非测试函数中，
 * - 常规规则：两边函数体都不少于 3 行，名字相同、名字切词 Jaccard ≥ 0.6 或函数体相似度 ≥ 0.5，score 达到 minScore；
 * - 同名重复规则：不同文件里名字和签名形状都相同，不看函数体长度和 score。
 * 和查询函数有直接调用关系的排除。score = 0.5 * 函数体 + 0.3 * 名字 + 0.2 * 签名形状
 * （anonymousIds 里的查询不计名字，函数体和签名形状按 5:2 归一），每个函数最多报告 3 个，同名重复优先。
 */
export function findDuplicates(input: SimilarInput): SimilarResult {
  const checked = input.symbols.filter(isCheckedFunction);
  const features = new Map(checked.map((s) => [s.id, functionFeatures(s)]));
  const pool = checked.filter((s) => !input.excludeIds?.has(s.id)).map((s) => features.get(s.id)!);
  const scanAll = input.queryIds === undefined;
  const byId = new Map(input.symbols.map((s) => [s.id, s]));
  const queries = scanAll
    ? pool
    : input.queryIds!.flatMap((id) => {
        const s = byId.get(id);
        return s && FUNCTION_KINDS.has(s.kind) ? [features.get(id) ?? functionFeatures(s)] : [];
      });
  const stats: SimilarStats = { queries: queries.length, candidates: 0, filtered: 0, aboveThreshold: 0, sameName: 0, findings: 0 };
  const withLsh = scanAll || queries.length > EXACT_BODY_QUERY_MAX;
  const ctx: ScanContext = { input, index: buildIndex(pool, withLsh), stats, ...(scanAll ? { reported: new Set<string>() } : {}) };
  const ordered = [...queries].sort((a, b) => a.symbol.symbolKey.localeCompare(b.symbol.symbolKey));
  const findings = ordered.flatMap((q) => findingFor(q, ctx) ?? []);
  stats.findings = findings.length;
  return { findings, stats };
}

/** 有 call / reference 边相连的符号对（任一方向） */
export function linkedPairs(store: Store, snapshotId: number, ids: string[]): Set<string> {
  const out = new Set<string>();
  for (const dir of ['in', 'out'] as const) {
    for (const e of store.getEdgesForSymbols(snapshotId, ids, dir, ['call', 'reference'])) {
      if (e.srcId !== e.dstId) out.add(pairKey(e.srcId, e.dstId));
    }
  }
  return out;
}

export interface SimilarInSnapshotOptions {
  /** 不传时全库扫描 */
  queryIds?: string[];
  excludeIds?: Set<string>;
  minScore: number;
  maxCandidates?: number;
}

/** 在一个快照里找重复实现：批量取符号（带 norm_tokens）和查询函数的边，再在内存里计算 */
export function similarInSnapshot(store: Store, snapshotId: number, opts: SimilarInSnapshotOptions): SimilarResult {
  const started = Date.now();
  const symbols = store.getSymbols(snapshotId, { withTokens: true });
  const linkIds = opts.queryIds ?? symbols.filter(isCheckedFunction).map((s) => s.id);
  const result = findDuplicates({ ...opts, symbols, linkedPairs: linkedPairs(store, snapshotId, linkIds) });
  log.info('similar_done', { snapshotId, mode: opts.queryIds ? 'symbols' : 'all', symbols: symbols.length, ...result.stats, minScore: opts.minScore, ms: Date.now() - started });
  return result;
}

/** 传入代码片段的虚拟路径，不会和仓库里的文件重名 */
export const SNIPPET_PATH = '<snippet>/snippet.py';

/** 解析代码片段里的函数；片段里没有函数定义时（只有一段函数体）包成一个名为 snippet 的匿名函数 */
async function snippetFunctions(code: string, snapshotId: number): Promise<{ functions: SymbolRow[]; anonymous: boolean }> {
  const parser = await getPythonParser();
  const parse = (source: string) =>
    extractPythonFile(parser, SNIPPET_PATH, source, { isTest: false, isGenerated: false })
      .symbols.filter((s) => FUNCTION_KINDS.has(s.kind))
      .map(({ nameLine: _l, nameCol: _c, ...s }) => ({ ...s, snapshotId }));
  const found = parse(code);
  if (found.length > 0) return { functions: found, anonymous: false };
  const body = code.split('\n').map((l) => '    ' + l).join('\n');
  return { functions: parse(`def snippet():\n${body}\n`), anonymous: true };
}

export interface SimilarToCodeResult extends SimilarResult {
  /** 从代码片段里解析出的函数（finding 里的 symbol 指向它们） */
  queries: SymbolRow[];
}

/**
 * 找和一段尚未写入仓库的代码相似的已有函数（AI 写代码前查重）。片段不在调用图里，不做透传 / 包装排除。
 * 只有函数体、被包装成函数的片段没有真实名字，按匿名查询处理。
 */
export async function similarToCode(store: Store, snapshotId: number, code: string, opts: { minScore: number; maxCandidates?: number }): Promise<SimilarToCodeResult> {
  const started = Date.now();
  const { functions: queries, anonymous } = await snippetFunctions(code, snapshotId);
  const queryIds = queries.map((q) => q.id);
  const symbols = [...store.getSymbols(snapshotId, { withTokens: true }), ...queries];
  const anonymousIds = anonymous ? new Set(queryIds) : undefined;
  const result = findDuplicates({ symbols, queryIds, excludeIds: new Set(queryIds), anonymousIds, linkedPairs: new Set(), ...opts });
  log.info('similar_done', { snapshotId, mode: 'code', functions: queries.length, anonymous, ...result.stats, minScore: opts.minScore, ms: Date.now() - started });
  return { ...result, queries };
}
