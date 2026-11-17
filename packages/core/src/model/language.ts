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

/** 各语言的支持级别；表里没有的语言为 none */
const LANG_SUPPORT: Partial<Record<Language, SupportLevel>> = {
  python: 'full',
  go: 'full',
};

export function detectLanguage(filePath: string): Language {
  return EXT_LANG[path.posix.extname(filePath).toLowerCase()] ?? 'unknown';
}

/** 路径在 `vendor/` 或 `testdata/` 目录下（任意深度）：Go 的依赖副本和测试数据，不当作项目代码 */
export function inGoExcludedDir(filePath: string): boolean {
  return filePath.split('/').slice(0, -1).some((d) => d === 'vendor' || d === 'testdata');
}

/** 文件的支持级别；path 用于按目录排除个别语言的文件（Go 的 vendor、testdata） */
export function supportLevelOf(language: Language, filePath: string): SupportLevel {
  if (language === 'go' && inGoExcludedDir(filePath)) return 'none';
  return LANG_SUPPORT[language] ?? 'none';
}

export function isSupported(filePath: string): boolean {
  return supportLevelOf(detectLanguage(filePath), filePath) !== 'none';
}
