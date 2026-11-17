import path from 'node:path';
import type { Language } from '../model/language.js';

export interface ClassifyOptions {
  /** 额外的测试代码 glob，来自配置 */
  testGlobs?: string[];
  /** 额外的生成代码 glob，来自配置 */
  generatedGlobs?: string[];
}

const DEFAULT_GENERATED = [
  '**/*_pb2.py', '**/*_pb2_grpc.py', '**/migrations/*.py',
  '**/*.pb.go', '**/*.pb.gw.go', '**/*_gen.go',
];

/** 内容判断只看文件开头这么多字符 */
export const GENERATED_HEAD_CHARS = 2048;

/** Go 生成代码的标准标记行（https://go.dev/s/generatedcode） */
const GO_GENERATED_LINE = /^\/\/ Code generated .* DO NOT EDIT\.\r?$/m;

export function isTestPath(filePath: string, opts: ClassifyOptions = {}): boolean {
  const parts = filePath.split('/');
  const base = parts[parts.length - 1] ?? '';
  const dirs = parts.slice(0, -1);
  if (dirs.includes('tests')) return true;
  if (/^test_.*\.py$/.test(base) || /_test\.py$/.test(base) || base === 'conftest.py') return true;
  if (/_test\.go$/.test(base)) return true;
  return matchesAny(filePath, opts.testGlobs ?? []);
}

export function isGeneratedPath(filePath: string, opts: ClassifyOptions = {}): boolean {
  return matchesAny(filePath, [...DEFAULT_GENERATED, ...(opts.generatedGlobs ?? [])]);
}

export function matchesAny(filePath: string, globs: string[]): boolean {
  return globs.some((g) => path.posix.matchesGlob(filePath, g));
}

/** 按文件开头的内容判断生成代码：Go 文件前 GENERATED_HEAD_CHARS 个字符里有 `// Code generated ... DO NOT EDIT.` 行 */
export function isGeneratedContent(language: Language, head: string): boolean {
  return language === 'go' && GO_GENERATED_LINE.test(head.slice(0, GENERATED_HEAD_CHARS));
}
