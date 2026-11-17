import path from 'node:path';
import { inGoExcludedDir } from '../model/language.js';

/** go.mod 的 module 行；没有时为 undefined */
export function parseGoModulePath(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const m = /^\s*module\s+("([^"]+)"|`([^`]+)`|(\S+))/.exec(line.replace(/\/\/.*$/, ''));
    if (m) return m[2] ?? m[3] ?? m[4];
  }
  return undefined;
}

/** 文件所在目录（相对仓库根目录）；根目录为空字符串 */
function dirOf(filePath: string): string {
  const dir = path.posix.dirname(filePath);
  return dir === '.' ? '' : dir;
}

/**
 * 一个 go.mod 文件对应的 `目录 → module 路径`；不是 go.mod、在 vendor/testdata 下、
 * 或没有 module 行时为 undefined
 */
export function goModuleEntry(filePath: string, text: string): [string, string] | undefined {
  if (path.posix.basename(filePath) !== 'go.mod' || inGoExcludedDir(filePath)) return undefined;
  const module = parseGoModulePath(text);
  return module ? [dirOf(filePath), module] : undefined;
}

export interface GoModuleRef {
  /** go.mod 所在目录（相对仓库根目录），根目录为空字符串 */
  dir: string;
  module: string;
}

/** 文件所属的 module：从文件所在目录向上找最近的 go.mod */
export function goModuleOf(filePath: string, modules: ReadonlyMap<string, string>): GoModuleRef | undefined {
  let best: GoModuleRef | undefined;
  const dir = dirOf(filePath);
  for (const [mdir, module] of modules) {
    const inside = mdir === '' || dir === mdir || dir.startsWith(`${mdir}/`);
    if (inside && (!best || mdir.length > best.dir.length)) best = { dir: mdir, module };
  }
  return best;
}

/**
 * 文件所在包的导入路径：module 路径加上相对 go.mod 所在目录的目录；
 * 找不到 go.mod 时用相对仓库根目录的目录，根目录下的文件用包名
 */
export function goPackagePath(filePath: string, modules: ReadonlyMap<string, string>, packageName: string): string {
  const dir = dirOf(filePath);
  const mod = goModuleOf(filePath, modules);
  if (!mod) return dir || packageName;
  const rel = mod.dir === '' ? dir : dir.slice(mod.dir.length + 1);
  return rel ? `${mod.module}/${rel}` : mod.module;
}
