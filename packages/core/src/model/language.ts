import path from 'node:path';

export type Language =
  | 'python'
  | 'java'
  | 'kotlin'
  | 'typescript'
  | 'javascript'
  | 'go'
  | 'rust'
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
  '.rs': 'rust',
};

/** 各语言的支持级别；表里没有的语言为 none */
const LANG_SUPPORT: Partial<Record<Language, SupportLevel>> = {
  python: 'full',
  go: 'full',
  rust: 'full',
};

export function detectLanguage(filePath: string): Language {
  return EXT_LANG[path.posix.extname(filePath).toLowerCase()] ?? 'unknown';
}

/** 路径在 `vendor/` 或 `testdata/` 目录下（任意深度）：Go 的依赖副本和测试数据，不当作项目代码 */
export function inGoExcludedDir(filePath: string): boolean {
  return filePath.split('/').slice(0, -1).some((d) => d === 'vendor' || d === 'testdata');
}

/** 文件所在目录（相对仓库根目录），根目录为空字符串 */
function parentDir(filePath: string): string {
  const dir = path.posix.dirname(filePath);
  return dir === '.' ? '' : dir;
}

/**
 * 不当作项目代码的 Rust 目录：文件清单里每个 Cargo.toml 所在目录下一级的 `target/`、`vendor/`
 * （构建输出和依赖副本）；项目里别处叫 vendor 的模块目录不受影响
 */
export function rustExcludedDirs(paths: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const p of paths) {
    if (path.posix.basename(p) !== 'Cargo.toml') continue;
    const dir = parentDir(p);
    for (const name of ['target', 'vendor']) out.add(dir ? `${dir}/${name}` : name);
  }
  return out;
}

/** 路径在 rustExcludedDirs 给出的某个目录下 */
export function inRustExcludedDir(filePath: string, excluded: ReadonlySet<string>): boolean {
  for (let dir = parentDir(filePath); dir !== ''; dir = parentDir(dir)) if (excluded.has(dir)) return true;
  return false;
}

/**
 * 文件的支持级别；path 用于按目录排除个别语言的文件（Go 的 vendor、testdata；Rust 的 rustExcluded 目录，
 * 没有完整文件清单、不传 rustExcluded 时不排除）
 */
export function supportLevelOf(language: Language, filePath: string, rustExcluded?: ReadonlySet<string>): SupportLevel {
  if (language === 'go' && inGoExcludedDir(filePath)) return 'none';
  if (language === 'rust' && rustExcluded && inRustExcludedDir(filePath, rustExcluded)) return 'none';
  return LANG_SUPPORT[language] ?? 'none';
}

export function isSupported(filePath: string): boolean {
  return supportLevelOf(detectLanguage(filePath), filePath) !== 'none';
}
