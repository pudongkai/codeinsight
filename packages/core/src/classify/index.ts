import path from 'node:path';

export interface ClassifyOptions {
  /** 额外的测试代码 glob，来自配置 */
  testGlobs?: string[];
  /** 额外的生成代码 glob，来自配置 */
  generatedGlobs?: string[];
}

const DEFAULT_GENERATED = ['**/*_pb2.py', '**/*_pb2_grpc.py', '**/migrations/*.py'];

export function isTestPath(filePath: string, opts: ClassifyOptions = {}): boolean {
  const parts = filePath.split('/');
  const base = parts[parts.length - 1] ?? '';
  const dirs = parts.slice(0, -1);
  if (dirs.includes('tests')) return true;
  if (/^test_.*\.py$/.test(base) || /_test\.py$/.test(base) || base === 'conftest.py') return true;
  return matchesAny(filePath, opts.testGlobs ?? []);
}

export function isGeneratedPath(filePath: string, opts: ClassifyOptions = {}): boolean {
  return matchesAny(filePath, [...DEFAULT_GENERATED, ...(opts.generatedGlobs ?? [])]);
}

export function matchesAny(filePath: string, globs: string[]): boolean {
  return globs.some((g) => path.posix.matchesGlob(filePath, g));
}
