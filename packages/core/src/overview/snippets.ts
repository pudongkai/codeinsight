import { log } from '../log.js';
import type { SymbolRow } from '../model/types.js';
import { readFailureReason, sliceLines } from '../snapshot/source.js';

export interface SnippetLimits {
  /** 每个模块最多几个片段 */
  perModule: number;
  /** 每个片段最多几行，超出部分换成一行省略说明 */
  maxLines: number;
  /** 整个模块的片段累计字符上限 */
  maxCharsPerModule: number;
}

export const DEFAULT_SNIPPET_LIMITS: SnippetLimits = { perModule: 6, maxLines: 60, maxCharsPerModule: 12_000 };

/** 发给 LLM 的源码片段，不带行号 */
export interface Snippet {
  key: string;
  code: string;
}

/** 片段只取函数和方法（类体可能很长，模型类另有类体前几行） */
function candidates(ranked: SymbolRow[]): SymbolRow[] {
  return ranked.filter((s) => s.kind === 'function' || s.kind === 'method');
}

function clip(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return [...lines.slice(0, maxLines), `# ...（省略 ${lines.length - maxLines} 行）`].join('\n');
}

/** 读不到时记日志并返回 undefined；read 由调用方负责按文件缓存 */
function fileReader(moduleId: string, read: (path: string) => Promise<string>): (path: string) => Promise<string | undefined> {
  return async (p) => {
    try {
      return await read(p);
    } catch (err) {
      log.warn('overview_snippet_skipped', { module: moduleId, path: p, reason: readFailureReason(err) });
      return undefined;
    }
  };
}

/**
 * 关键函数源码片段（第 8 步）：按 rankedOwnSymbols 的顺序（HTTP 接口优先 → 本模块内调用方数 → key）取前 perModule 个，
 * 每个最多 maxLines 行，累计超过 maxCharsPerModule 时停止。读不到的文件跳过并记日志。
 */
export async function moduleSnippets(
  moduleId: string, ranked: SymbolRow[], read: (path: string) => Promise<string>, limits: SnippetLimits = DEFAULT_SNIPPET_LIMITS,
): Promise<Snippet[]> {
  const out: Snippet[] = [];
  const readFile = fileReader(moduleId, read);
  let chars = 0;
  for (const s of candidates(ranked)) {
    if (out.length >= limits.perModule) break;
    const text = await readFile(s.path);
    const range = text === undefined ? undefined : sliceLines(text, s.startLine, s.endLine);
    if (!range) continue;
    const code = clip(range.content, limits.maxLines);
    if (chars + code.length > limits.maxCharsPerModule) break;
    chars += code.length;
    out.push({ key: s.symbolKey, code });
  }
  log.debug('overview_snippets', { module: moduleId, snippets: out.length, chars });
  return out;
}

/** 模块摘要输入里每个数据模型带的类体行数（从 class 行算起） */
export const MODEL_HEAD_LINES = 15;

/** 数据模型类的前 MODEL_HEAD_LINES 行（不带行号），用于模块摘要输入；读不到的跳过 */
export async function modelHeads(moduleId: string, models: SymbolRow[], read: (path: string) => Promise<string>): Promise<Snippet[]> {
  const readFile = fileReader(moduleId, read);
  const out: Snippet[] = [];
  for (const s of models) {
    const text = await readFile(s.path);
    const range = text === undefined ? undefined : sliceLines(text, s.startLine, Math.min(s.endLine, s.startLine + MODEL_HEAD_LINES - 1));
    if (range) out.push({ key: s.symbolKey, code: range.content });
  }
  return out;
}
