import type { Parser } from 'web-tree-sitter';
import type { Language } from '../model/language.js';
import type { SymbolRow } from '../model/types.js';
import { resolveDjangoEntries } from './entries.js';
import { resolveModels } from './models.js';
import { extractGoFile, restoreGoFile } from './go.js';
import { resolveGoEntries } from './go-entries.js';
import { completeGoFiles } from './go-index.js';
import { resolveGoModels } from './go-models.js';
import { getGoParser, getPythonParser, getRustParser } from './parser.js';
import { extractPythonFile, restoreExtractedFile, type FileFlags } from './python.js';
import { extractRustFile, restoreRustFile } from './rust.js';
import { resolveRustEntries } from './rust-entries.js';
import { completeRustFiles } from './rust-index.js';
import { resolveRustModels } from './rust-models.js';
import type { RustPackage } from './rust-cargo.js';
import type { ExtractedEntry, ExtractedFile } from './types.js';

/** 提取时需要的仓库级信息 */
export interface ExtractContext {
  /** Go module 所在目录（相对仓库根目录）→ module 路径；其他语言忽略 */
  goModules: ReadonlyMap<string, string>;
  /** cargo 包所在目录（相对仓库根目录）→ 包信息；其他语言忽略 */
  rustCrates: ReadonlyMap<string, RustPackage>;
}

export function emptyExtractContext(): ExtractContext {
  return { goModules: new Map(), rustCrates: new Map() };
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

const go: LanguageSupport = {
  language: 'go',
  grammarPackage: 'tree-sitter-go',
  getParser: getGoParser,
  extractFile: (parser, path, source, flags, ctx) => extractGoFile(parser, path, source, flags, ctx.goModules),
  restoreFile: (parser, path, source, rows, ctx) => restoreGoFile(parser, path, source, rows, ctx.goModules),
  completeForResolve: (files) => {
    completeGoFiles(files);
  },
  resolveCrossFile: (files) => {
    const index = completeGoFiles(files);
    return { entries: resolveGoEntries(files, index), models: resolveGoModels(files) };
  },
};

const rust: LanguageSupport = {
  language: 'rust',
  grammarPackage: 'tree-sitter-rust',
  getParser: getRustParser,
  extractFile: (parser, path, source, flags, ctx) => extractRustFile(parser, path, source, flags, ctx.rustCrates),
  restoreFile: (parser, path, source, rows, ctx) => restoreRustFile(parser, path, source, rows, ctx.rustCrates),
  completeForResolve: (files) => {
    completeRustFiles(files);
  },
  resolveCrossFile: (files) => {
    const index = completeRustFiles(files);
    return { entries: resolveRustEntries(files, index), models: resolveRustModels(files) };
  },
};

const SUPPORTS: readonly LanguageSupport[] = [python, go, rust];

export function languageSupport(lang: Language): LanguageSupport | undefined {
  return SUPPORTS.find((s) => s.language === lang);
}

export function allLanguageSupports(): readonly LanguageSupport[] {
  return SUPPORTS;
}
