import type { ExtractedFile } from '../extract/types.js';
import { log } from '../log.js';
import type { Language } from '../model/language.js';
import { GoResolver } from './go.js';
import { RustResolver } from './rust.js';
import { ScipPythonResolver } from './scip-python.js';
import type { EdgeSources, FailedLanguage, ResolveInput, ResolveResult, Resolver } from './types.js';

/** 各语言的子解析器 */
export type LanguageResolvers = Partial<Record<Language, Resolver>>;

interface LanguageOutcome {
  language: Language;
  result?: ResolveResult;
  error?: string;
}

function groupByLanguage(files: ExtractedFile[]): Map<Language, ExtractedFile[]> {
  const out = new Map<Language, ExtractedFile[]>();
  for (const f of files) {
    const group = out.get(f.language);
    if (group) group.push(f);
    else out.set(f.language, [f]);
  }
  return out;
}

/** 多种语言时 note 前面加上语言名，只有一种时保持原样 */
function joinNotes(outcomes: LanguageOutcome[]): string | undefined {
  const notes = outcomes.filter((o) => o.result?.note).map((o) => ({ language: o.language, note: o.result!.note! }));
  if (notes.length === 0) return undefined;
  if (outcomes.length === 1) return notes[0]!.note;
  return notes.map((n) => `${n.language}: ${n.note}`).join('\n');
}

/**
 * 按语言组合的解析器：只对快照里出现、且注册了子解析器的语言调用对应的子解析器，边合并返回。
 * 某个语言的子解析器抛异常时记进 failed，其他语言的边照常返回；被中止时整体抛出。
 */
export class LanguageResolver implements Resolver {
  readonly name = 'languages';
  /** prepare 传入的、注册了子解析器的语言（排序后） */
  private present: Language[];

  constructor(private readonly resolvers: LanguageResolvers) {
    this.present = this.registered(Object.keys(resolvers) as Language[]);
  }

  private registered(languages: Iterable<Language>): Language[] {
    return [...new Set(languages)].filter((l) => this.resolvers[l]).sort();
  }

  async prepare(languages: Language[]): Promise<void> {
    this.present = this.registered(languages);
    for (const l of this.present) await this.resolvers[l]!.prepare?.([l]);
  }

  /** 只拼接本快照出现的语言的子解析器版本，没出现的语言的解析代码改动不影响复用 */
  get version(): string {
    return this.present.map((l) => `${l}=${this.resolvers[l]!.version ?? ''}`).join(';');
  }

  async resolve(input: ResolveInput): Promise<ResolveResult> {
    const groups = groupByLanguage(input.files);
    const outcomes: LanguageOutcome[] = [];
    for (const language of this.registered(groups.keys())) {
      outcomes.push(await this.resolveLanguage(language, { ...input, files: groups.get(language)! }));
    }
    const skipped = [...groups.keys()].filter((l) => !this.resolvers[l]);
    if (skipped.length > 0) log.info('resolve_language_skipped', { languages: skipped.join(','), reason: 'no resolver' });
    return this.combine(outcomes);
  }

  private async resolveLanguage(language: Language, input: ResolveInput): Promise<LanguageOutcome> {
    const sub = this.resolvers[language]!;
    const started = Date.now();
    try {
      const result = await sub.resolve(input);
      log.info('resolve_language_done', {
        language, resolver: sub.name, files: input.files.length, edges: result.edges.length,
        source: result.sources?.[language]?.source ?? 'scip', ms: Date.now() - started,
      });
      return { language, result };
    } catch (err) {
      if (input.signal?.aborted) throw err;
      const error = (err as Error).message;
      log.warn('resolve_language_failed', { language, resolver: sub.name, files: input.files.length, error: error.split('\n')[0], ms: Date.now() - started });
      return { language, error };
    }
  }

  private combine(outcomes: LanguageOutcome[]): ResolveResult {
    const sources: EdgeSources = {};
    const failed: FailedLanguage[] = [];
    const versions: string[] = [];
    const at = Date.now();
    for (const o of outcomes) {
      const sub = this.resolvers[o.language]!;
      if (o.result) {
        sources[o.language] = o.result.sources?.[o.language] ?? { source: 'scip' };
        versions.push(`${o.language}=${o.result.effectiveVersion ?? sub.version ?? ''}`);
      } else {
        failed.push({ language: o.language, reason: o.error! });
        sources[o.language] = { source: 'failed', at, note: o.error!.split('\n')[0] };
      }
    }
    return {
      edges: outcomes.flatMap((o) => o.result?.edges ?? []),
      note: joinNotes(outcomes),
      sources,
      effectiveVersion: versions.join(';'),
      ...(failed.length > 0 ? { failed } : {}),
    };
  }

  /** 任一语言的子解析器认为需要重新解析时返回 true；只问 sources 里记录了的语言 */
  async needsReresolve(sources: EdgeSources): Promise<boolean> {
    for (const l of this.registered(Object.keys(sources) as Language[])) {
      const sub = this.resolvers[l]!;
      if (sub.needsReresolve && (await sub.needsReresolve(sources))) return true;
    }
    return false;
  }
}

/** 默认解析器：Python 用 scip-python，Go 用 GoResolver，Rust 用 RustResolver */
export function defaultResolver(): LanguageResolver {
  return new LanguageResolver({ python: new ScipPythonResolver(), go: new GoResolver(), rust: new RustResolver() });
}
