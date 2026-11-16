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
 * 或因为外部工具运行失败回退且已过去 FAILED_RERESOLVE_AFTER_MS。返回 true 时再由解析器的 needsReresolve 细判
 */
export function mayNeedReresolve(sources: EdgeSources | null | undefined, now = Date.now()): boolean {
  return Object.values(sources ?? {}).some((s) => s.source === 'name_match'
    && (s.reason === 'not_found' || (s.reason === 'failed' && now - (s.at ?? 0) >= FAILED_RERESOLVE_AFTER_MS)));
}
