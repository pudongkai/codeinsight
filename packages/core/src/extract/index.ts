import { log } from '../log.js';
import { resolveDjangoEntries } from './entries.js';
import { getPythonParser } from './parser.js';
import { extractPythonFile, type FileFlags } from './python.js';
import type { ExtractedEntry, ExtractedFile } from './types.js';

export * from './types.js';
export { normalizeTokens } from './normalize.js';
export { extractPythonFile, moduleDottedName, restoreExtractedFile, sha1 } from './python.js';
export { getPythonParser } from './parser.js';

export interface SourceFile extends FileFlags {
  path: string;
  source: string;
}

export interface ExtractResult {
  files: ExtractedFile[];
  /** 装饰器入口和 Django 路由入口 */
  entries: ExtractedEntry[];
}

/** 提取一批 Python 文件；单个文件失败时跳过并记日志，不影响其他文件 */
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
  return { files, entries };
}
