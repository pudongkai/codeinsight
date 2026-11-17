import { existsSync } from 'node:fs';
import path from 'node:path';
import { codeHash, DEFAULT_CODE_ROOT } from '../extract/cache.js';

/** 各语言基于 SCIP 的解析共用的模块（相对源码根目录，不含扩展名）；language-resolver 负责按语言分组和合并各语言的边 */
export const SHARED_SCIP_RESOLVER_MODULES = [
  'resolve/types', 'resolve/language-resolver', 'resolve/scip-edges', 'resolve/scip-rules', 'scip/reader', 'scip/runner', 'scip/merge',
] as const;

/**
 * 一种语言的解析代码指纹：只覆盖这种语言用到的模块和外部工具包版本，
 * 别的语言的解析代码改动不影响它，复用调用边的判断按语言互不干扰
 */
export function resolverCodeHash(language: string, modules: readonly string[], packages: readonly string[], root = DEFAULT_CODE_ROOT): string {
  const files = (): string[] => {
    const out: string[] = [];
    for (const mod of modules) {
      for (const ext of ['.ts', '.js']) if (existsSync(path.join(root, mod + ext))) out.push(mod + ext);
    }
    return out.sort();
  };
  return codeHash(`resolve:${language}`, root, files, packages);
}
