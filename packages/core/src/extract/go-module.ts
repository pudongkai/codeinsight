import { readFile } from 'node:fs/promises';
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

/** 去掉 go.mod / go.work 里路径两侧的引号 */
function unquote(text: string): string {
  const m = /^"([^"]*)"$|^`([^`]*)`$/.exec(text);
  return m ? (m[1] ?? m[2]!) : text;
}

/** go.work 的 use 路径（单行 `use ./a` 和块 `use ( ... )` 两种写法），原样返回，不做规范化 */
export function parseGoWorkUses(text: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (inBlock) {
      if (line.startsWith(')')) inBlock = false;
      else if (line) out.push(unquote(line));
      continue;
    }
    const m = /^use(?=[\s(])\s*(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[1]!.trim();
    if (rest.startsWith('(')) {
      const inner = rest.slice(1).trim();
      if (inner.endsWith(')')) out.push(...inner.slice(0, -1).trim().split(/\s+/).filter(Boolean).map(unquote));
      else inBlock = true;
    } else if (rest) {
      out.push(unquote(rest));
    }
  }
  return out;
}

/** 文件所在目录（相对仓库根目录）；根目录为空字符串 */
export function dirOf(filePath: string): string {
  const dir = path.posix.dirname(filePath);
  return dir === '.' ? '' : dir;
}

/** dir 和它的各级上层目录，由近到远，最后是仓库根目录（空字符串） */
export function goAncestorDirs(dir: string): string[] {
  const out = [dir];
  for (let d = dir; d !== ''; out.push(d)) d = dirOf(d);
  return out;
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

/**
 * 从磁盘读出文件所在目录及各级上层目录（不超过 root）里的 go.mod，得到 `目录 → module 路径`；
 * vendor、testdata 下的 go.mod 不算（和提取时的 goModuleEntry 一致）
 */
export async function readGoModules(root: string, filePaths: Iterable<string>): Promise<Map<string, string>> {
  const seen = new Set<string>();
  const out = new Map<string, string>();
  for (const p of filePaths) {
    for (const dir of goAncestorDirs(dirOf(p))) {
      if (seen.has(dir)) break;
      seen.add(dir);
      const file = dir ? `${dir}/go.mod` : 'go.mod';
      const text = await readFile(path.join(root, file), 'utf8').catch(() => undefined);
      const entry = text === undefined ? undefined : goModuleEntry(file, text);
      if (entry) out.set(...entry);
    }
  }
  return out;
}
