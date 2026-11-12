import { log } from '../log.js';
import { resolveDjangoEntries } from './entries.js';
import { resolveModels } from './models.js';
import { getPythonParser } from './parser.js';
import { extractPythonFile, type FileFlags } from './python.js';
import type { ExtractedEntry, ExtractedFile } from './types.js';

export * from './types.js';
export { bodySimilarity, normalizeTokens, shingles, SHINGLE_SIZE } from './normalize.js';
export { collectImportModules, extractPythonFile, moduleDottedName, restoreExtractedFile, sha1 } from './python.js';
export type { ImportedModule } from './python.js';
export { getPythonParser } from './parser.js';
export { resolveModels } from './models.js';

export interface SourceFile extends FileFlags {
  path: string;
  source: string;
}

export interface ExtractResult {
  files: ExtractedFile[];
  /** 装饰器入口和 Django 路由入口 */
  entries: ExtractedEntry[];
  /** 识别出的数据模型类个数 */
  models: number;
}

/** 提取一批 Python 文件并识别跨文件的入口和模型类；单个文件失败时跳过并记日志，不影响其他文件 */
export async function extractPythonFiles(sources: SourceFile[]): Promise<ExtractResult> {
  const parser = await getPythonParser();
  const files: ExtractedFile[] = [];
  for (const s of sources) {
    try {
      files.push(extractPythonFile(parser, s.path, s.source, s));
    } catch (err) {
      log.warn('extract_file_failed', { path: s.path, error: (err as Error).message });
    }
  }
  const entries = [...files.flatMap((f) => f.entries), ...resolveDjangoEntries(files)];
  return { files, entries, models: resolveModels(files) };
}
