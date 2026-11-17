import { ownValue } from './go-types.js';
import { canonicalRustPath, isRustTraitImplMethod } from './rust-syntax.js';
import { stripDedupSuffix } from '../model/symbol-key.js';
import type { ExtractedFile, ExtractedSymbol, RustFileFacts, RustPathRef, RustTypeChain, RustUseScope } from './types.js';

/** resolvePath 的结果：项目里的符号（函数、方法、类型、trait，或模块所在文件的 module 符号），或外部 crate */
export type ResolvedPath = { symbol: ExtractedSymbol; file: ExtractedFile } | { external: string };

/** 标准库 crate */
export const RUST_STD_CRATES: ReadonlySet<string> = new Set(['std', 'core', 'alloc', 'proc_macro', 'test']);

/** `pub use` 再导出最多跟几层 */
const MAX_REEXPORTS = 3;
/** use 绑定和再导出加起来的递归上限，防止互相引用的 use 死循环 */
const MAX_HOPS = 8;

const key = (...parts: string[]): string => parts.join('\0');

/** 一个模块位置：crate 目标根文件 + 模块路径（文件模块或内联 mod） */
interface ModuleLoc {
  target: string;
  path: string[];
}

/** 一次解析的递归计数 */
interface Hops {
  reexports: number;
  total: number;
  /** 发起这一步解析的文件所在的 crate 目标 */
  from: string;
}

const TYPE_KINDS = new Set(['class', 'interface']);
const ITEM_KINDS = new Set(['function', 'class', 'interface']);

function isResolvedSymbol(r: ResolvedPath | undefined): r is { symbol: ExtractedSymbol; file: ExtractedFile } {
  return r !== undefined && 'symbol' in r;
}

const NO_USES: RustUseScope = { uses: {}, globUses: [], pubUses: {} };

/** 模块路径 modPath（文件模块加内联 mod）处的 use 绑定：文件模块用文件级的，内联 mod 用它自己的 */
function useScopeAt(r: RustFileFacts, modPath: readonly string[]): RustUseScope {
  const inline = modPath.slice(r.modulePath.length);
  return inline.length === 0 ? r : (r.modUses?.[inline.join('::')] ?? NO_USES);
}

/**
 * 一个快照里 Rust 符号的查找表：按（crate 目标，模块路径，名字）找函数、类型、trait，模块路径 → 所在文件，
 * lib crate 名 → 目标，类型/trait → 方法；提供 resolvePath 和跨文件的类型推断
 */
export class RustSymbolIndex {
  private readonly items = new Map<string, { symbol: ExtractedSymbol; file: ExtractedFile }>();
  private readonly modules = new Map<string, ExtractedFile>();
  private readonly libs = new Map<string, string>();
  private readonly targets = new Set<string>();
  private readonly symbolFiles = new Map<string, ExtractedFile>();
  private readonly symbols = new Map<string, ExtractedSymbol>();
  private methodTable?: { byOwner: Map<string, ExtractedSymbol[]>; byName: Map<string, ExtractedSymbol[]> };

  constructor(files: readonly ExtractedFile[]) {
    for (const f of files) if (f.rust) this.addFile(f);
  }

  private addFile(f: ExtractedFile): void {
    const r = f.rust!;
    this.targets.add(r.target);
    this.modules.set(key(r.target, ...r.modulePath), f);
    if (r.targetKind === 'lib' && r.modulePath.length === 0) this.libs.set(r.crate, r.target);
    for (const m of r.inlineMods) this.modules.set(key(r.target, ...r.modulePath, ...m), f);
    const moduleQn = f.symbols[0]?.qualifiedName ?? '';
    const parentKinds = new Map(f.symbols.map((s) => [s.id, s.kind]));
    for (const s of f.symbols) {
      this.symbols.set(s.id, s);
      this.symbolFiles.set(s.id, f);
      if (!ITEM_KINDS.has(s.kind) || parentKinds.get(s.parentId ?? '') !== 'module') continue;
      const inline = stripDedupSuffix(s.qualifiedName).slice(moduleQn.length + 2).split('::').slice(0, -1);
      this.items.set(key(r.target, ...r.modulePath, ...inline, '', s.name), { symbol: s, file: f });
    }
  }

  symbol(id: string): ExtractedSymbol | undefined {
    return this.symbols.get(id);
  }

  /** 符号所在的文件 */
  fileOf(id: string): ExtractedFile | undefined {
    return this.symbolFiles.get(id);
  }

  /** lib crate 名（`-` 已换成 `_`）对应的目标根文件 */
  libTarget(crate: string): string | undefined {
    return this.libs.get(crate);
  }

  private methods(): NonNullable<RustSymbolIndex['methodTable']> {
    if (this.methodTable) return this.methodTable;
    const byOwner = new Map<string, ExtractedSymbol[]>();
    const byName = new Map<string, ExtractedSymbol[]>();
    for (const s of this.symbols.values()) {
      if (s.kind !== 'method') continue;
      if (s.parentId) byOwner.set(s.parentId, [...(byOwner.get(s.parentId) ?? []), s]);
      byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
    }
    this.methodTable = { byOwner, byName };
    return this.methodTable;
  }

  /** 类型的方法（固有 impl 和 trait impl）或 trait 声明的方法中叫 name 的 */
  methodsOf(typeId: string, name: string): ExtractedSymbol[] {
    return (this.methods().byOwner.get(typeId) ?? []).filter((m) => m.name === name);
  }

  /** 类型上叫 name 的方法：有固有 impl 的取它，否则只有一个候选时取它（多个 trait 都实现了同名方法时为 undefined） */
  method(typeId: string, name: string): ExtractedSymbol | undefined {
    const all = this.methodsOf(typeId, name);
    const inherent = all.filter((m) => !isRustTraitImplMethod(m));
    if (inherent.length === 1) return inherent[0];
    return all.length === 1 ? all[0] : undefined;
  }

  /** 项目里所有叫这个名字的方法（含 trait 声明的方法） */
  methodsNamed(name: string): readonly ExtractedSymbol[] {
    return this.methods().byName.get(name) ?? [];
  }

  /** 父符号改动后（跨文件补 impl 方法的父符号）重新建方法表 */
  resetMethods(): void {
    this.methodTable = undefined;
  }

  /**
   * 在文件 file 里（mod 为所在的内联 mod）解析一条路径。第一段依次按 `crate`/`self`/`super`、所在模块的 use 绑定、
   * 当前模块里的项和子模块、工作区里的 lib crate 名、glob use 指向的模块、同目录下的 `tests/<dir>` 这类目标解析；
   * 经过 `pub use` 再导出时最多跟三层。解析到外部 crate 或标准库时返回 `{ external }`，`Self` 开头的要调用方先替换
   */
  resolvePath(file: ExtractedFile, segments: readonly string[], mod: readonly string[] = []): ResolvedPath | undefined {
    if (!file.rust) return undefined;
    return this.resolveIn(file, segments, [...file.rust.modulePath, ...mod], { reexports: 0, total: 0, from: file.rust.target });
  }

  private resolveIn(file: ExtractedFile, segments: readonly string[], modPath: string[], from: Hops): ResolvedPath | undefined {
    const r = file.rust!;
    const hops = { ...from, from: r.target };
    const canon = canonicalRustPath(segments, modPath);
    const [first, ...rest] = canon ?? [];
    if (first === undefined || first === 'Self' || hops.total > MAX_HOPS) return undefined;
    if (first === 'crate') return this.walk({ target: r.target, path: [] }, rest, hops);
    const scope = useScopeAt(r, modPath);
    const bound = ownValue(scope.uses, first);
    if (bound && !(bound.length === 1 && bound[0] === first)) {
      return this.resolveIn(file, [...bound, ...rest], modPath, { ...hops, total: hops.total + 1 });
    }
    const here = { target: r.target, path: modPath };
    const local = this.step(here, first, rest, hops);
    if (local || this.hasName(here, first)) return local;
    const lib = this.libs.get(first);
    if (lib) return this.walk({ target: lib, path: [] }, rest, hops);
    return this.viaGlobs(file, scope, modPath, first, rest, hops) ?? this.siblingTarget(r.target, first, rest, hops) ?? externalOf(first, canon!.length);
  }

  /** 模块里有这个名字的项或子模块 */
  private hasName(loc: ModuleLoc, name: string): boolean {
    return this.items.has(key(loc.target, ...loc.path, '', name)) || this.modules.has(key(loc.target, ...loc.path, name));
  }

  /** glob use 指向的模块里找第一段 */
  private viaGlobs(file: ExtractedFile, scope: RustUseScope, modPath: string[], first: string, rest: string[], hops: Hops): ResolvedPath | undefined {
    for (const g of scope.globUses) {
      const target = this.resolveIn(file, g, modPath, { ...hops, total: hops.total + 1 });
      const loc = isResolvedSymbol(target) ? this.moduleLocOf(target) : undefined;
      const found = loc ? this.step(loc, first, rest, hops) : undefined;
      if (found) return found;
    }
    return undefined;
  }

  /** `tests/it.rs` 里的 `common::x` 指向虚拟目标 `tests/common` */
  private siblingTarget(target: string, first: string, rest: string[], hops: Hops): ResolvedPath | undefined {
    const dir = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '';
    const sibling = dir ? `${dir}/${first}` : first;
    return this.targets.has(sibling) && sibling !== target ? this.walk({ target: sibling, path: [] }, rest, hops) : undefined;
  }

  /** 解析到的 module 符号对应的模块位置；不是 module 符号时为 undefined */
  private moduleLocOf(r: { symbol: ExtractedSymbol; file: ExtractedFile }): ModuleLoc | undefined {
    return r.symbol.kind === 'module' && r.file.rust ? { target: r.file.rust.target, path: r.file.rust.modulePath } : undefined;
  }

  /** 从模块位置出发依次走 segments；走完时为模块所在文件的 module 符号 */
  private walk(loc: ModuleLoc, segments: string[], hops: Hops): ResolvedPath | undefined {
    const [seg, ...rest] = segments;
    if (seg === undefined) {
      const f = this.modules.get(key(loc.target, ...loc.path));
      return f?.symbols[0] ? { symbol: f.symbols[0], file: f } : undefined;
    }
    return this.step(loc, seg, rest, hops);
  }

  /** 模块里的一段：项（类型后面还有一段时为它的方法）、子模块、模块文件里的 use 再导出 */
  private step(loc: ModuleLoc, seg: string, rest: string[], hops: Hops): ResolvedPath | undefined {
    const item = this.items.get(key(loc.target, ...loc.path, '', seg));
    if (item) return rest.length === 0 ? item : this.member(item, rest);
    if (this.modules.has(key(loc.target, ...loc.path, seg))) return this.walk({ target: loc.target, path: [...loc.path, seg] }, rest, hops);
    return this.reexport(loc, seg, rest, hops);
  }

  /** `Type::m`、`Trait::m` */
  private member(item: { symbol: ExtractedSymbol; file: ExtractedFile }, rest: string[]): ResolvedPath | undefined {
    if (rest.length !== 1 || !TYPE_KINDS.has(item.symbol.kind)) return undefined;
    const m = this.method(item.symbol.id, rest[0]!);
    const file = m && this.fileOf(m.id);
    return m && file ? { symbol: m, file } : undefined;
  }

  /** 模块（文件模块或内联 mod）里的 use 绑定：同一目标里看全部 use，其他目标只看 `pub use` */
  private reexport(loc: ModuleLoc, seg: string, rest: string[], hops: Hops): ResolvedPath | undefined {
    const f = this.modules.get(key(loc.target, ...loc.path));
    if (!f?.rust || hops.reexports >= MAX_REEXPORTS) return undefined;
    const scope = useScopeAt(f.rust, loc.path);
    const bound = ownValue(scope.pubUses, seg) ?? (hops.from === loc.target ? ownValue(scope.uses, seg) : undefined);
    if (!bound) return undefined;
    return this.resolveIn(f, [...bound, ...rest], loc.path, { ...hops, reexports: hops.reexports + 1, total: hops.total + 1 });
  }

  /** 路径解析到的类型或 trait 符号 id */
  typeId(file: ExtractedFile, ref: RustPathRef): string | undefined {
    const r = this.resolvePath(file, ref.segments, ref.mod);
    return isResolvedSymbol(r) && TYPE_KINDS.has(r.symbol.kind) ? r.symbol.id : undefined;
  }

  /** 函数或方法的返回类型（类型符号 id） */
  fnResultType(fnId: string): string | undefined {
    const f = this.fileOf(fnId);
    const ref = f?.rust ? ownValue(f.rust.fnResults, fnId) : undefined;
    return f && ref ? this.typeId(f, ref) : undefined;
  }

  /** struct 字段的类型（类型符号 id） */
  fieldType(typeId: string, field: string): string | undefined {
    const f = this.fileOf(typeId);
    const ref = f?.rust ? ownValue(ownValue(f.rust.structFields, typeId), field) : undefined;
    return f && ref ? this.typeId(f, ref) : undefined;
  }

  /** 类型线索在 file 里（mod 为所在的内联 mod）算出的类型符号 id；中途任一步查不到时为 undefined */
  chainType(file: ExtractedFile, chain: RustTypeChain, mod?: string[]): string | undefined {
    let type: string | undefined;
    if ('type' in chain.root) type = this.typeId(file, { segments: chain.root.type, mod });
    else {
      const callee = this.resolvePath(file, chain.root.call, mod);
      type = isResolvedSymbol(callee) ? this.fnResultType(callee.symbol.id) : undefined;
    }
    for (const field of chain.fields) {
      if (type === undefined) return undefined;
      type = this.fieldType(type, field);
    }
    return type;
  }

  /** impl 方法的父符号还挂在 module 上的，按 impl 目标类型的路径改为同一 crate 目标里的类型符号 */
  linkImplParents(files: readonly ExtractedFile[]): void {
    for (const f of files) {
      const moduleId = f.symbols[0]?.id;
      for (const s of f.symbols) {
        const ref = s.kind === 'method' && s.parentId === moduleId ? ownValue(f.rust?.implTypes, s.id) : undefined;
        const owner = ref ? this.resolvePath(f, ref.segments, ref.mod) : undefined;
        if (isResolvedSymbol(owner) && TYPE_KINDS.has(owner.symbol.kind) && owner.file.rust?.target === f.rust!.target) s.parentId = owner.symbol.id;
      }
    }
    this.resetMethods();
  }
}

/** 解析不了的第一段：标准库或多段路径按外部 crate 处理，单段名字为 undefined */
function externalOf(first: string, length: number): ResolvedPath | undefined {
  return RUST_STD_CRATES.has(first) || length > 1 ? { external: first } : undefined;
}

/** method 形式调用点还没有接收者类型的，按全部文件的类型信息补上 */
function fillReceiverTypes(f: ExtractedFile, index: RustSymbolIndex): void {
  for (const c of f.rust!.calls) {
    if (c.form !== 'method' || c.receiverType || !c.receiverChain) continue;
    const type = index.chainType(f, c.receiverChain, c.mod);
    if (type) c.receiverType = type;
  }
}

/**
 * Rust 的跨文件补全（提取后和重试解析还原后都调用，结果相同）：impl 方法的跨文件父符号、调用点的接收者类型。
 * 返回建好的索引，供之后的名称匹配、入口识别等使用
 */
export function completeRustFiles(files: readonly ExtractedFile[]): RustSymbolIndex {
  const rustFiles = files.filter((f) => f.rust);
  const index = new RustSymbolIndex(rustFiles);
  index.linkImplParents(rustFiles);
  for (const f of rustFiles) fillReceiverTypes(f, index);
  return index;
}
