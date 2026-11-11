import path from 'node:path';

export type Language =
  | 'python'
  | 'java'
  | 'kotlin'
  | 'typescript'
  | 'javascript'
  | 'go'
  | 'unknown';

/** full：提取 + 解析；structure：只有提取；none：只做文件级 diff */
export type SupportLevel = 'full' | 'structure' | 'none';

const EXT_LANG: Record<string, Language> = {
  '.py': 'python',
  '.pyi': 'python',
  '.java': 'java',
  '.kt': 'kotlin',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.go': 'go',
};

/** 当前版本只支持 Python；其他语言后续阶段加入时只改这张表。 */
const LANG_SUPPORT: Partial<Record<Language, SupportLevel>> = {
  python: 'full',
};

export function detectLanguage(filePath: string): Language {
  return EXT_LANG[path.posix.extname(filePath).toLowerCase()] ?? 'unknown';
}

export function supportLevelOf(language: Language): SupportLevel {
  return LANG_SUPPORT[language] ?? 'none';
}

export function isSupported(filePath: string): boolean {
  return supportLevelOf(detectLanguage(filePath)) !== 'none';
}
