import type { Parser } from 'web-tree-sitter';
import { log } from '../log.js';
import type { Language } from '../model/language.js';
import { emptyExtractContext, languageSupport, type ExtractContext, type LanguageSupport } from './languages.js';
import type { FileFlags } from './python.js';
import type { ExtractedEntry, ExtractedFile } from './types.js';

export * from './types.js';
export { bodySimilarity, normalizeTokens, shingles, SHINGLE_SIZE } from './normalize.js';
export { collectImportModules, extractPythonFile, moduleDottedName, restoreExtractedFile } from './python.js';
export type { ImportedModule } from './python.js';
export { getGoParser, getPythonParser } from './parser.js';
export { collectGoEnvReads, collectGoImports, extractGoFile, restoreGoFile } from './go.js';
export type { GoImport } from './go.js';
export { completeGoFiles, findGoFunc, GoSymbolIndex } from './go-index.js';
export { resolveGoEntries } from './go-entries.js';
export { resolveGoModels } from './go-models.js';
export { goModuleEntry, goModuleOf, goPackagePath, parseGoModulePath } from './go-module.js';
export { resolveModels } from './models.js';
export { allLanguageSupports, emptyExtractContext, languageSupport } from './languages.js';
export type { CrossFileResult, ExtractContext, LanguageSupport } from './languages.js';
export { sha1 } from '../util/hash.js';

export interface SourceFile extends FileFlags {
  path: string;
  source: string;
}

/** 带语言的提取输入，按语言选提取实现 */
export interface LanguageSourceFile extends SourceFile {
  language: Language;
}

export interface ExtractResult {
  files: ExtractedFile[];
  /** 装饰器入口和路由入口 */
  entries: ExtractedEntry[];
  /** 识别出的数据模型类个数 */
  models: number;
}

/** 已加载的各语言解析器 */
export type ParserSet = Map<Language, { support: LanguageSupport; parser: Parser }>;

/** 加载这些语言的解析器；没有提取实现的语言跳过 */
export async function loadParsers(languages: Iterable<Language>): Promise<ParserSet> {
  const out: ParserSet = new Map();
  for (const lang of new Set(languages)) {
    const support = languageSupport(lang);
    if (support) out.set(lang, { support, parser: await support.getParser() });
  }
  return out;
}

/** 按文件语言提取一个文件；该语言没有加载解析器时抛出 */
export function extractSource(parsers: ParserSet, s: LanguageSourceFile, ctx: ExtractContext): ExtractedFile {
  const p = parsers.get(s.language);
  if (!p) throw new Error(`no extractor for language ${s.language}`);
  return p.support.extractFile(p.parser, s.path, s.source, s, ctx);
}

/** 按语言分组，保持各组内的原顺序，组按首次出现的顺序排列 */
function groupByLanguage(files: ExtractedFile[]): Map<Language, ExtractedFile[]> {
  const groups = new Map<Language, ExtractedFile[]>();
  for (const f of files) {
    const group = groups.get(f.language);
    if (group) group.push(f);
    else groups.set(f.language, [f]);
  }
  return groups;
}

/** 一批带语言的文件逐个提取并做跨文件识别；单个文件失败时跳过并记日志，不影响其他文件 */
export async function extractFiles(sources: LanguageSourceFile[], ctx: ExtractContext = emptyExtractContext()): Promise<ExtractResult> {
  const parsers = await loadParsers(sources.map((s) => s.language));
  const files: ExtractedFile[] = [];
  for (const s of sources) {
    try {
      files.push(extractSource(parsers, s, ctx));
    } catch (err) {
      log.warn('extract_file_failed', { path: s.path, error: (err as Error).message });
    }
  }
  return resolveCrossFile(files);
}

/** 提取一批 Python 文件并识别跨文件的入口和模型类 */
export function extractPythonFiles(sources: SourceFile[]): Promise<ExtractResult> {
  return extractFiles(sources.map((s) => ({ ...s, language: 'python' })));
}

/** 全部文件提取完后，按语言做跨文件识别（入口、数据模型），结果合并 */
export function resolveCrossFile(files: ExtractedFile[]): ExtractResult {
  const entries: ExtractedEntry[] = [];
  let models = 0;
  for (const [lang, group] of groupByLanguage(files)) {
    const support = languageSupport(lang);
    if (!support) continue;
    const r = support.resolveCrossFile(group);
    entries.push(...r.entries);
    models += r.models;
  }
  return { files, entries, models };
}

/** 重试解析时，还原全部文件后按语言补齐解析要用的跨文件信息 */
export function completeForResolve(files: ExtractedFile[]): void {
  for (const [lang, group] of groupByLanguage(files)) languageSupport(lang)?.completeForResolve?.(group);
}
