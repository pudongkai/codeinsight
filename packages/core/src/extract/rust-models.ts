import type { ModelKind } from '../model/types.js';
import type { ExtractedFile, ExtractedSymbol, RustDerives } from './types.js';

const DIESEL_DERIVES = new Set(['Queryable', 'Selectable', 'Insertable', 'AsChangeset', 'Identifiable']);

/** 按 derive 和属性判断 struct 的模型类别：diesel、sqlx（FromRow）、sea_orm（DeriveEntityModel），否则 serde 为 json */
function rustModelKind(d: RustDerives): ModelKind | null {
  if (d.derives.some((x) => DIESEL_DERIVES.has(x)) || d.attrs.some((a) => a === 'diesel' || a.startsWith('diesel::'))) return 'diesel';
  if (d.derives.includes('FromRow')) return 'sqlx';
  if (d.derives.includes('DeriveEntityModel')) return 'sea_orm';
  if (d.derives.includes('Serialize') || d.derives.includes('Deserialize')) return 'json';
  return null;
}

/** struct（enum、union 不算数据模型） */
function isStruct(s: ExtractedSymbol): boolean {
  return /(^|\s)struct\s/.test(s.displaySignature);
}

/** 判断 Rust 文件里的 struct 是不是数据模型，结果写进符号的 modelKind，返回模型个数 */
export function resolveRustModels(files: readonly ExtractedFile[]): number {
  let count = 0;
  for (const f of files) {
    const derives = f.rust?.derives ?? {};
    for (const s of f.symbols) {
      if (s.kind !== 'class') continue;
      const d = Object.hasOwn(derives, s.id) ? derives[s.id] : undefined;
      s.modelKind = d && isStruct(s) ? rustModelKind(d) : null;
      if (s.modelKind) count++;
    }
  }
  return count;
}
