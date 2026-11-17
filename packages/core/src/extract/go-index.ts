import { ownValue, resolveChain, splitQualified, type GoTypeLookup } from './go-types.js';
import type { ExtractedFile, ExtractedSymbol, GoFileFacts, GoFuncRef } from './types.js';

/** 包导入路径和名字拼成查找键 */
const key = (...parts: string[]): string => parts.join('\0');

function byName(a: ExtractedFile, b: ExtractedFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** 包的代表文件：有 `// Package xxx` 文档注释的非测试文件；没有时取路径排序第一的非测试文件，再没有时取第一个文件 */
function pickRepresentative(files: ExtractedFile[]): ExtractedFile {
  const sorted = [...files].sort(byName);
  const nonTest = sorted.filter((f) => !f.symbols[0]?.isTest);
  return nonTest.find((f) => /^Package\s/.test(f.symbols[0]?.docstring ?? '')) ?? nonTest[0] ?? sorted[0]!;
}

/** 外部测试包（`package xxx_test`，和被测包在同一目录）：包路径和被测包相同，但看不到被测包的未导出名字 */
export function isGoExternalTest(go: Pick<GoFileFacts, 'packagePath' | 'packageName'>, filePath: string): boolean {
  return go.packageName.endsWith('_test') && filePath.endsWith('_test.go');
}

/**
 * 按名字查找函数时用的包键：外部测试包加上 `_test` 后缀，和被测包分开，
 * 这样被测包里不带包名的调用不会连到测试包的函数，反过来也一样
 */
export function goLookupPackage(f: ExtractedFile): string {
  return isGoExternalTest(f.go!, f.path) ? `${f.go!.packagePath}_test` : f.go!.packagePath;
}

/**
 * 从查找包 from 出发查 pkg 里的名字时依次尝试的键：外部测试包里的类型和被测包的同名类型 qualifiedName 相同，
 * from 是 pkg 的外部测试包时先查测试包自己的声明，查不到再查被测包。
 * 已知限制：测试包里有和被测包同名的符号时，外部测试包里引用被测包的这个名字（如 `b.Thing`）也会连到测试包自己的符号
 */
function packageKeys(pkg: string, from: string | undefined): string[] {
  return from === `${pkg}_test` ? [from, pkg] : [pkg];
}

/**
 * 一个快照里 Go 符号的查找表：按（包，名字）找函数，按（包，类型，名字）找方法，按（包，名字）找类型，
 * 每个包的代表文件；同时提供跨文件的类型信息（struct 字段类型、函数第一个返回类型）。
 * 包键都用 goLookupPackage（外部测试包带 `_test` 后缀），查找时可传入查找方所在的包键（见 packageKeys）
 */
export class GoSymbolIndex implements GoTypeLookup {
  private readonly funcs = new Map<string, ExtractedSymbol>();
  private readonly methods = new Map<string, ExtractedSymbol>();
  private readonly types = new Map<string, ExtractedSymbol>();
  private readonly methodsByName = new Map<string, ExtractedSymbol[]>();
  private readonly packages = new Map<string, ExtractedFile[]>();
  private readonly structFields = new Map<string, Record<string, string>>();
  private readonly funcResults = new Map<string, string>();

  constructor(files: readonly ExtractedFile[]) {
    for (const f of files) if (f.go) this.addFile(f);
  }

  private addFile(f: ExtractedFile): void {
    const pkg = f.go!.packagePath;
    const lookupPkg = goLookupPackage(f);
    this.packages.set(pkg, [...(this.packages.get(pkg) ?? []), f]);
    for (const s of f.symbols) this.addSymbol(pkg, lookupPkg, s);
    for (const [t, fields] of Object.entries(f.go!.structFields)) this.structFields.set(key(lookupPkg, t), fields);
    for (const [fn, result] of Object.entries(f.go!.funcResults)) this.funcResults.set(key(lookupPkg, fn), result);
  }

  /** pkg 是 qualifiedName 的前缀；lookupPkg 是查找键（外部测试包带 `_test` 后缀） */
  private addSymbol(pkg: string, lookupPkg: string, s: ExtractedSymbol): void {
    const local = s.qualifiedName.slice(pkg.length + 1);
    if (s.kind === 'function') this.funcs.set(key(lookupPkg, local), s);
    else if (s.kind === 'class' || s.kind === 'interface') this.types.set(key(lookupPkg, local), s);
    else if (s.kind === 'method') {
      const [type, name] = splitQualified(local);
      this.methods.set(key(lookupPkg, type, name), s);
      this.methodsByName.set(name, [...(this.methodsByName.get(name) ?? []), s]);
    }
  }

  func(pkg: string, name: string): ExtractedSymbol | undefined {
    return this.funcs.get(key(pkg, name));
  }

  /** 按 packageKeys 的顺序在 map 里取第一个查到的值 */
  private find<T>(map: ReadonlyMap<string, T>, pkg: string, from: string | undefined, ...rest: string[]): T | undefined {
    for (const p of packageKeys(pkg, from)) {
      const v = map.get(key(p, ...rest));
      if (v !== undefined) return v;
    }
    return undefined;
  }

  method(pkg: string, type: string, name: string, from?: string): ExtractedSymbol | undefined {
    return this.find(this.methods, pkg, from, type, name);
  }

  type(pkg: string, name: string, from?: string): ExtractedSymbol | undefined {
    return this.find(this.types, pkg, from, name);
  }

  /** 项目里所有叫这个名字的方法（含 interface 方法） */
  methodsNamed(name: string): readonly ExtractedSymbol[] {
    return this.methodsByName.get(name) ?? [];
  }

  /** 是项目里的包 */
  hasPackage(pkg: string): boolean {
    return this.packages.has(pkg);
  }

  /** 包的代表文件；不是项目里的包时为 undefined */
  representative(pkg: string): ExtractedFile | undefined {
    const files = this.packages.get(pkg);
    return files ? pickRepresentative(files) : undefined;
  }

  field(typeName: string, field: string, from?: string): string | undefined {
    const [pkg, type] = splitQualified(typeName);
    for (const p of packageKeys(pkg, from)) {
      const v = ownValue(this.structFields.get(key(p, type)), field);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  funcResult(funcName: string, from?: string): string | undefined {
    const [pkg, name] = splitQualified(funcName);
    return this.find(this.funcResults, pkg, from, name);
  }

  /** 从查找包 from 出发的类型信息查找 */
  lookupFrom(from: string): GoTypeLookup {
    return { field: (t, f) => this.field(t, f, from), funcResult: (fn) => this.funcResult(fn, from) };
  }
}

/**
 * 按名字引用的函数或方法对应的符号（pkg 为引用所在文件的 goLookupPackage）：函数名找同包函数，`pkg.Func` 找该包的函数，
 * 方法值有接收者类型时按类型找方法，没有时只在同名方法唯一时取它
 */
export function findGoFunc(index: GoSymbolIndex, ref: GoFuncRef, pkg: string): ExtractedSymbol | undefined {
  if (ref.form === 'ident') return index.func(pkg, ref.name);
  if (ref.form === 'pkg') return ref.qualifier ? index.func(ref.qualifier, ref.name) : undefined;
  const type = ref.receiverType ?? (ref.receiverChain ? resolveChain(ref.receiverChain, index.lookupFrom(pkg)) : undefined);
  if (type) {
    const [typePkg, typeName] = splitQualified(type);
    return index.method(typePkg, typeName, ref.name, pkg);
  }
  const same = index.methodsNamed(ref.name);
  return same.length === 1 ? same[0] : undefined;
}

/** 本文件里找不到接收者类型的方法，父符号改为同包其他文件里的类型符号 */
function linkMethodParents(f: ExtractedFile, index: GoSymbolIndex): void {
  const moduleId = f.symbols[0]?.id;
  const pkg = f.go!.packagePath;
  const lookupPkg = goLookupPackage(f);
  for (const s of f.symbols) {
    if (s.kind !== 'method' || s.parentId !== moduleId) continue;
    const [type] = splitQualified(s.qualifiedName.slice(pkg.length + 1));
    const owner = index.type(lookupPkg, type);
    if (owner) s.parentId = owner.id;
  }
}

/** 接收者类型要跨文件才能确定的调用点，按全部文件的类型信息补上 receiverType */
function fillReceiverTypes(f: ExtractedFile, index: GoSymbolIndex): void {
  const lookup = index.lookupFrom(goLookupPackage(f));
  for (const c of f.go!.calls) {
    if (c.receiverType || !c.receiverChain) continue;
    const type = resolveChain(c.receiverChain, lookup);
    if (type) c.receiverType = type;
  }
}

/**
 * Go 的跨文件补全（提取后和重试解析还原后都调用，结果相同）：方法的跨文件父符号、调用点的接收者类型。
 * 返回建好的索引，供之后的入口识别等使用
 */
export function completeGoFiles(files: readonly ExtractedFile[]): GoSymbolIndex {
  const index = new GoSymbolIndex(files);
  for (const f of files) {
    if (!f.go) continue;
    linkMethodParents(f, index);
    fillReceiverTypes(f, index);
  }
  return index;
}
