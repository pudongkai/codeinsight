import type { ModelKind } from '../model/types.js';
import type { ExtractedFile, GoStructTags } from './types.js';

/** 按字段标签判断 struct 的模型类别：gorm 标签或嵌入 gorm.Model 为 gorm，否则 db 标签为 sqlx，否则 json 标签为 json */
function goModelKind(tags: GoStructTags): ModelKind | null {
  if (tags.gormModel || tags.keys.includes('gorm')) return 'gorm';
  if (tags.keys.includes('db')) return 'sqlx';
  if (tags.keys.includes('json')) return 'json';
  return null;
}

/** 判断 Go 文件里的 struct 是不是数据模型，结果写进符号的 modelKind，返回模型个数 */
export function resolveGoModels(files: readonly ExtractedFile[]): number {
  let count = 0;
  for (const f of files) {
    const tags = f.go?.structTags ?? {};
    for (const s of f.symbols) {
      if (s.kind !== 'class') continue;
      const t = Object.hasOwn(tags, s.id) ? tags[s.id] : undefined;
      s.modelKind = t ? goModelKind(t) : null;
      if (s.modelKind) count++;
    }
  }
  return count;
}
