/**
 * 模块 id 的组成（见模块划分）：`<目录>` 整个目录；`<目录>/*` 目录下直接放的文件（根目录为 `*`）；
 * `<目录>#<组名>` 按文件拆出的一组（根目录为 `#<组名>`）。
 */
export interface ModuleIdParts {
  /** 模块所在目录，根目录为 `.` */
  dir: string;
  part: 'whole' | 'files' | 'cluster';
  cluster?: string;
}

export function parseModuleId(id: string): ModuleIdParts {
  if (id === '*') return { dir: '.', part: 'files' };
  if (id.endsWith('/*')) return { dir: id.slice(0, -2), part: 'files' };
  const hash = id.indexOf('#');
  if (hash >= 0) return { dir: hash === 0 ? '.' : id.slice(0, hash), part: 'cluster', cluster: id.slice(hash + 1) };
  return { dir: id, part: 'whole' };
}

/** 模块所在目录，根目录为 `.` */
export function moduleDir(id: string): string {
  return parseModuleId(id).dir;
}

/** 模块所在的顶层目录（系统简介分组用），根目录的模块为 `*` */
export function moduleTopDir(id: string): string {
  const { dir } = parseModuleId(id);
  return dir === '.' ? '*' : dir.split('/')[0]!;
}

/** 没有 LLM 名称时的模块名：目录名；直接文件组带上 `/*`，按文件拆的组带上 `#组名` */
export function defaultModuleName(id: string): string {
  const p = parseModuleId(id);
  const base = p.dir === '.' ? '' : p.dir.split('/').pop()!;
  if (p.part === 'files') return base ? `${base}/*` : '*';
  if (p.part === 'cluster') return `${base}#${p.cluster}`;
  return base;
}
