import type { Parser } from 'web-tree-sitter';
import type { Language } from '../model/language.js';
import type { SymbolRow } from '../model/types.js';
import { resolveDjangoEntries } from './entries.js';
import { resolveModels } from './models.js';
import { getPythonParser } from './parser.js';
import { extractPythonFile, restoreExtractedFile, type FileFlags } from './python.js';
import type { ExtractedEntry, ExtractedFile } from './types.js';

/** 提取时需要的仓库级信息 */
export interface ExtractContext {
  /** Go module 所在目录（相对仓库根目录）→ module 路径；其他语言忽略 */
  goModules: ReadonlyMap<string, string>;
}

export function emptyExtractContext(): ExtractContext {
  return { goModules: new Map() };
}

export interface CrossFileResult {
  entries: ExtractedEntry[];
  /** 识别出的数据模型类个数 */
  models: number;
}

/** 一种语言的提取实现：解析器、单文件提取和还原、跨文件处理 */
export interface LanguageSupport {
  language: Language;
  /** 进入 extract cache 指纹的语法包名 */
  grammarPackage: string;
  getParser(): Promise<Parser>;
  extractFile(parser: Parser, path: string, source: string, flags: FileFlags, ctx: ExtractContext): ExtractedFile;
  /** 从库里的符号还原解析层需要的 ExtractedFile */
  restoreFile(parser: Parser, path: string, source: string, rows: Omit<SymbolRow, 'snapshotId'>[], ctx: ExtractContext): ExtractedFile;
  /** 重试解析时，还原全部文件后调用：只补解析要用的跨文件信息 */
  completeForResolve?(files: ExtractedFile[]): void;
  /** 全部文件提取完后的跨文件处理：路由处理函数、数据模型（会改写 symbol.modelKind） */
  resolveCrossFile(files: ExtractedFile[]): CrossFileResult;
}

const python: LanguageSupport = {
  language: 'python',
  grammarPackage: 'tree-sitter-python',
  getParser: getPythonParser,
  extractFile: (parser, path, source, flags) => extractPythonFile(parser, path, source, flags),
  restoreFile: (parser, path, source, rows) => restoreExtractedFile(parser, path, source, rows),
  resolveCrossFile: (files) => ({
    entries: [...files.flatMap((f) => f.entries), ...resolveDjangoEntries(files)],
    models: resolveModels(files),
  }),
};

const SUPPORTS: readonly LanguageSupport[] = [python];

export function languageSupport(lang: Language): LanguageSupport | undefined {
  return SUPPORTS.find((s) => s.language === lang);
}

export function allLanguageSupports(): readonly LanguageSupport[] {
  return SUPPORTS;
}
