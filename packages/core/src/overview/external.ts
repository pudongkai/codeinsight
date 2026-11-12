import type { Node } from 'web-tree-sitter';
import { getPythonParser } from '../extract/parser.js';
import { collectImportModules, type ImportedModule } from '../extract/python.js';
import { log } from '../log.js';
import type { FileRow } from '../model/types.js';
import { readFailureReason } from '../snapshot/source.js';
import type { Warning } from '../report/types.js';
import { addToSet, pushTo } from '../util/collections.js';
import { classifyExternal, EXTERNAL_CATEGORIES } from './external-table.js';
import type { ExternalCategory, ExternalCategorySummary, ModuleEnvVar, ModuleExternal } from './types.js';
import { compareStrings } from '../util/compare.js';

export interface ExternalModuleInput {
  id: string;
  files: string[];
}

export interface ExternalInput {
  modules: ExternalModuleInput[];
  /** 快照的完整文件清单，用来认出项目内的包 */
  files: FileRow[];
  /** 按快照读文件（见 snapshot/source.ts），失败时抛错 */
  read: (path: string) => Promise<string>;
  table: ReadonlyMap<string, ExternalCategory>;
}

export interface ModuleExternalFacts {
  external: ModuleExternal[];
  envVars: ModuleEnvVar[];
}

export interface ExternalResult {
  byModule: Map<string, ModuleExternalFacts>;
  summary: ExternalCategorySummary[];
  warnings: Warning[];
}

/** 一个文件里找到的外部库和环境变量名 */
interface FileFacts {
  libs: { lib: string; category: ExternalCategory }[];
  envVars: string[];
}

const CATEGORY_ORDER: readonly ExternalCategory[] = [...EXTERNAL_CATEGORIES, 'other'];

/** 项目内的包：Python 文件路径的第一段（根目录文件去掉后缀），以及含 `__init__.py` 的目录名 */
export function projectPackages(files: readonly FileRow[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    if (f.language !== 'python') continue;
    const parts = f.path.split('/');
    out.add(parts.length === 1 ? parts[0]!.replace(/\.pyi?$/, '') : parts[0]!);
    if (/(^|\/)__init__\.pyi?$/.test(f.path) && parts.length > 1) out.add(parts[parts.length - 2]!);
  }
  return out;
}

/** 相对导入、项目内包的导入不算外部；其余按分类表归类，标准库不列出 */
export function externalLibs(imports: readonly ImportedModule[], packages: ReadonlySet<string>, table: ReadonlyMap<string, ExternalCategory>): FileFacts['libs'] {
  const out: FileFacts['libs'] = [];
  for (const imp of imports) {
    if (imp.relative || packages.has(imp.module.split('.')[0]!)) continue;
    const hit = classifyExternal(table, imp.module, imp.candidates);
    if (hit) out.push(hit);
  }
  return out;
}

// ---------- 环境变量 ----------

/** 字面量字符串的内容；含插值、拼接的不算 */
function literalString(node: Node | null | undefined): string | undefined {
  if (node?.type !== 'string' || node.namedChildren.some((c) => c.type === 'interpolation')) return undefined;
  return node.namedChildren.filter((c) => c.type === 'string_content').map((c) => c.text).join('');
}

/** `os.environ[...]` / `environ[...]`（from os import environ 时）的对象部分 */
function isEnvironObject(node: Node | null, bareEnviron: boolean): boolean {
  return node?.text === 'os.environ' || (bareEnviron && node?.type === 'identifier' && node.text === 'environ');
}

function isEnvGetter(fn: Node | null, bare: { environ: boolean; getenv: boolean }): boolean {
  if (!fn) return false;
  if (fn.text === 'os.getenv' || (bare.getenv && fn.type === 'identifier' && fn.text === 'getenv')) return true;
  return fn.type === 'attribute' && fn.childForFieldName('attribute')?.text === 'get' && isEnvironObject(fn.childForFieldName('object'), bare.environ);
}

function envReads(root: Node, imports: readonly ImportedModule[]): string[] {
  const fromOs = imports.filter((i) => !i.relative && i.module === 'os').flatMap((i) => i.candidates);
  const bare = { environ: fromOs.includes('os.environ'), getenv: fromOs.includes('os.getenv') };
  const out: string[] = [];
  for (const n of root.descendantsOfType(['subscript', 'call'])) {
    let name: string | undefined;
    if (n.type === 'subscript' && isEnvironObject(n.childForFieldName('value'), bare.environ)) {
      name = literalString(n.childForFieldName('subscript'));
    } else if (n.type === 'call' && isEnvGetter(n.childForFieldName('function'), bare)) {
      name = literalString(n.childForFieldName('arguments')?.firstNamedChild);
    }
    if (name) out.push(name);
  }
  return out;
}

function isSettingsClass(cls: Node): boolean {
  const bases = cls.childForFieldName('superclasses')?.namedChildren ?? [];
  return bases.some((b) => b.text === 'BaseSettings' || b.text.endsWith('.BaseSettings'));
}

/** 继承 pydantic BaseSettings 的类：字段名的大写形式就是读取的环境变量名 */
function settingsFields(root: Node): string[] {
  const out: string[] = [];
  for (const cls of root.descendantsOfType('class_definition')) {
    if (!isSettingsClass(cls)) continue;
    for (const stmt of cls.childForFieldName('body')?.namedChildren ?? []) {
      const assign = stmt.type === 'expression_statement' ? stmt.firstNamedChild : null;
      const left = assign?.type === 'assignment' ? assign.childForFieldName('left') : null;
      if (left?.type !== 'identifier' || left.text.startsWith('_') || left.text === 'model_config') continue;
      out.push(left.text.toUpperCase());
    }
  }
  return out;
}

// ---------- 按模块汇总 ----------

async function fileFacts(input: ExternalInput, packages: ReadonlySet<string>, file: string): Promise<FileFacts> {
  const source = await input.read(file);
  const parser = await getPythonParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error('tree-sitter failed to parse');
  try {
    const imports = collectImportModules(tree.rootNode);
    return { libs: externalLibs(imports, packages, input.table), envVars: [...envReads(tree.rootNode, imports), ...settingsFields(tree.rootNode)] };
  } finally {
    tree.delete();
  }
}

function sortedFiles(m: Map<string, Set<string>>): [string, string[]][] {
  return [...m].map(([k, v]): [string, string[]] => [k, [...v].sort()]).sort(([a], [b]) => compareStrings(a, b));
}

function moduleFacts(perFile: Map<string, FileFacts>): ModuleExternalFacts {
  const libsByCategory = new Map<ExternalCategory, Map<string, Set<string>>>();
  const env = new Map<string, Set<string>>();
  for (const [file, facts] of perFile) {
    for (const { lib, category } of facts.libs) {
      let libs = libsByCategory.get(category);
      if (!libs) libsByCategory.set(category, (libs = new Map()));
      addToSet(libs, lib, file);
    }
    for (const name of facts.envVars) addToSet(env, name, file);
  }
  const external = CATEGORY_ORDER.filter((c) => libsByCategory.has(c)).map((category) => {
    const libs = sortedFiles(libsByCategory.get(category)!);
    return { category, libs: libs.map(([l]) => l), files: [...new Set(libs.flatMap(([, f]) => f))].sort() };
  });
  return { external, envVars: sortedFiles(env).map(([name, files]) => ({ name, files })) };
}

function summarize(byModule: Map<string, ModuleExternalFacts>): ExternalCategorySummary[] {
  const libs = new Map<ExternalCategory, Set<string>>();
  const modules = new Map<ExternalCategory, string[]>();
  for (const [id, facts] of [...byModule].sort(([a], [b]) => compareStrings(a, b))) {
    for (const e of facts.external) {
      for (const l of e.libs) addToSet(libs, e.category, l);
      pushTo(modules, e.category, id);
    }
  }
  return CATEGORY_ORDER.filter((c) => libs.has(c)).map((category) => ({ category, libs: [...libs.get(category)!].sort(), modules: modules.get(category)! }));
}

/**
 * 外部依赖和环境变量（概览第 3 步）：从快照重新解析模块里的全部 Python 文件（含没有符号的文件）。
 * 单个文件读不到或解析失败时跳过并记日志，结果里加一条 warning。
 */
export async function collectExternal(input: ExternalInput): Promise<ExternalResult> {
  const packages = projectPackages(input.files);
  const byModule = new Map<string, ModuleExternalFacts>();
  const skipped: string[] = [];
  for (const m of input.modules) {
    const perFile = new Map<string, FileFacts>();
    for (const file of m.files.filter((f) => /\.pyi?$/.test(f))) {
      try {
        perFile.set(file, await fileFacts(input, packages, file));
      } catch (err) {
        skipped.push(file);
        log.warn('overview_external_file_skipped', { path: file, reason: readFailureReason(err) });
      }
    }
    byModule.set(m.id, moduleFacts(perFile));
    await new Promise((r) => setImmediate(r));
  }
  log.info('overview_external_done', { modules: byModule.size, skippedFiles: skipped.length });
  const warnings: Warning[] = skipped.length === 0 ? [] : [{
    code: 'external_files_skipped', level: 'warning',
    message: `${skipped.length} file(s) could not be read from the snapshot; their imports and environment variables are not included (e.g. ${skipped[0]})`,
  }];
  return { byModule, summary: summarize(byModule), warnings };
}
