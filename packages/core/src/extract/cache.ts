import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha1 } from './python.js';
import type { BaseVarKind, ExtractedFile, ImportBinding } from './types.js';

/**
 * 提取代码指纹清单：`extract/` 下全部模块，加上 extract 引用的、会影响缓存内容的目录外模块（不含扩展名）。
 * extract 新引用了别的项目模块时要加进这里或 FINGERPRINT_IGNORED，测试会检查。
 */
export const FINGERPRINT_EXTRA_MODULES = ['model/symbol-key', 'util/collections'] as const;

/** 不影响缓存内容、不进指纹的模块：只写日志，或只有类型 */
export const FINGERPRINT_IGNORED_MODULES = ['log', 'model/types'] as const;

/** 解析结果随语法版本变化的依赖包，版本号进指纹 */
const GRAMMAR_PACKAGES = ['tree-sitter-python', 'web-tree-sitter'] as const;

/** 运行时的源码根目录：构建后是 dist/，vitest 下是 src/ */
export const DEFAULT_CODE_ROOT = fileURLToPath(new URL('..', import.meta.url));

function isModuleFile(name: string): boolean {
  return /\.(ts|js)$/.test(name) && !name.endsWith('.d.ts');
}

/** 目录下的模块文件（相对 root 的路径） */
export function moduleFilesIn(root: string, dir: string): string[] {
  return readdirSync(path.join(root, dir)).filter(isModuleFile).map((n) => `${dir}/${n}`);
}

/** 指纹清单里的文件（相对 root 的路径，按路径排序） */
export function fingerprintFiles(root = DEFAULT_CODE_ROOT): string[] {
  const files = moduleFilesIn(root, 'extract');
  for (const mod of FINGERPRINT_EXTRA_MODULES) {
    for (const ext of ['.ts', '.js']) {
      if (existsSync(path.join(root, mod + ext))) files.push(mod + ext);
    }
  }
  return files.sort();
}

/** 包版本：包没有导出 package.json 时从入口文件所在目录向上查找 */
export function packageVersion(name: string): string {
  const require = createRequire(import.meta.url);
  let dir = path.dirname(require.resolve(name));
  for (;;) {
    const file = path.join(dir, 'package.json');
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === name) return pkg.version ?? '';
    }
    const parent = path.dirname(dir);
    if (parent === dir) return '';
    dir = parent;
  }
}

const hashes = new Map<string, string>();

/** 一组模块文件的内容和依赖包版本求 sha1，进程内按 tag 和 root 缓存 */
export function codeHash(tag: string, root: string, files: () => string[], packages: readonly string[]): string {
  const cacheKey = `${tag}\0${root}`;
  const cached = hashes.get(cacheKey);
  if (cached) return cached;
  const parts: string[] = [];
  for (const rel of files()) parts.push(rel, sha1(readFileSync(path.join(root, rel))));
  for (const name of packages) parts.push(name, packageVersion(name));
  const hash = sha1(parts.join('\0'));
  hashes.set(cacheKey, hash);
  return hash;
}

/** 提取代码指纹：提取相关代码或语法包版本有任何改动时都会变，旧缓存自然不命中 */
export function extractCodeHash(root = DEFAULT_CODE_ROOT): string {
  return codeHash('extract', root, () => fingerprintFiles(root), GRAMMAR_PACKAGES);
}

export interface ExtractCacheKeyParts {
  path: string;
  contentHash: string;
  isTest: boolean;
  isGenerated: boolean;
}

export function extractCacheKey(codeHash: string, p: ExtractCacheKeyParts): string {
  return sha1([codeHash, p.path, p.contentHash, p.isTest ? '1' : '0', p.isGenerated ? '1' : '0'].join('\0'));
}

type SerializedFile = Omit<ExtractedFile, 'imports' | 'baseVars'> & {
  imports: [string, ImportBinding][];
  baseVars?: [string, BaseVarKind][];
};

/** 单个文件的提取结果转成 JSON，Map 存成键值对数组 */
export function serializeExtractedFile(file: ExtractedFile): string {
  const out: SerializedFile = { ...file, imports: [...file.imports], baseVars: file.baseVars ? [...file.baseVars] : undefined };
  return JSON.stringify(out);
}

export function deserializeExtractedFile(data: string): ExtractedFile {
  const raw = JSON.parse(data) as SerializedFile;
  return { ...raw, imports: new Map(raw.imports), baseVars: raw.baseVars ? new Map(raw.baseVars) : undefined };
}
