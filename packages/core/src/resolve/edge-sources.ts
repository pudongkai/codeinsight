import type { Language } from '../model/language.js';
import type { EdgeSource, EdgeSources } from '../model/types.js';

/** 边来源为指定类别的语言 */
export function languagesWithSource(sources: EdgeSources | null, source: EdgeSource['source']): Language[] {
  if (!sources) return [];
  return (Object.entries(sources) as [Language, EdgeSource][]).filter(([, s]) => s.source === source).map(([l]) => l);
}

/** 写日志用的简短描述，如 `python=scip,go=name_match(not_found)` */
export function sourcesText(sources: EdgeSources | null | undefined): string {
  if (!sources) return '';
  return (Object.entries(sources) as [Language, EdgeSource][])
    .map(([l, s]) => `${l}=${s.source}${s.reason ? `(${s.reason})` : ''}`)
    .join(',');
}

/** 某种语言因为外部工具运行失败才回退到名称匹配：这样的边不复用，之后要重新解析 */
export function hasFailedFallback(sources: EdgeSources | undefined): boolean {
  return Object.values(sources ?? {}).some((s) => s.source === 'name_match' && s.reason === 'failed');
}

/** 外部工具运行失败后，隔这么久才再次尝试重新解析，避免每次打开快照都重跑 */
export const FAILED_RERESOLVE_AFTER_MS = 60 * 60 * 1000;

/**
 * 不调用解析器、只看记录判断有没有可能需要重新解析：某种语言因为找不到外部工具回退到名称匹配，
 * 或因为外部工具运行失败回退且已过去 FAILED_RERESOLVE_AFTER_MS（disabled、no_module 不算）。返回 true 时再由解析器的 needsReresolve 细判
 */
export function mayNeedReresolve(sources: EdgeSources | null | undefined, now = Date.now()): boolean {
  return Object.values(sources ?? {}).some((s) => s.source === 'name_match'
    && (s.reason === 'not_found' || (s.reason === 'failed' && now - (s.at ?? 0) >= FAILED_RERESOLVE_AFTER_MS)));
}

/**
 * 一种语言的边来自名称匹配时，现在外部工具可用（toolsOk）的情况下要不要重新解析：之前找不到工具，
 * 或之前运行失败且已过去 FAILED_RERESOLVE_AFTER_MS。disabled、no_module 时装了工具也用不上，不重新解析
 */
export function toolNeedsReresolve(source: EdgeSource | undefined, toolsOk: boolean, now = Date.now()): boolean {
  if (source?.source !== 'name_match' || !toolsOk) return false;
  if (source.reason === 'not_found') return true;
  return source.reason === 'failed' && now - (source.at ?? 0) >= FAILED_RERESOLVE_AFTER_MS;
}
