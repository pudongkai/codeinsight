/** 符号的类型标记：HTTP 接口、数据模型、方法。图节点、列表、改动清单共用 */

import { httpRoute, isHttpApi, type EntryLike } from '@codeinsight/core/model/entry';

export type MarkKind = 'api' | 'model' | 'method';

export interface Mark {
  kind: MarkKind;
  label: string;
  /** 悬停提示，接口为 `GET /users/{id}` 这样的方法和路径 */
  title: string;
}

/** 能算出标记的符号字段：API 的 SymbolInfo、报告的 SymbolRef / SymbolChange 都满足 */
export interface MarkSource {
  kind: string;
  modelKind?: string;
  entry?: EntryLike;
}

const MODEL_LABELS: Record<string, string> = {
  pydantic: 'Pydantic', sqlmodel: 'SQLModel', sqlalchemy: 'SQLAlchemy', django: 'Django',
  typeddict: 'TypedDict', namedtuple: 'NamedTuple', dataclass: 'dataclass', attrs: 'attrs',
};

export function isModel(s: MarkSource): boolean {
  return Boolean(s.modelKind);
}

export function symbolMarks(s: MarkSource): Mark[] {
  const marks: Mark[] = [];
  if (isHttpApi(s.entry)) {
    const route = httpRoute(s.entry);
    marks.push({ kind: 'api', label: '接口', title: `HTTP 接口（${s.entry.framework}）${route ? ` ${route}` : ''}` });
  }
  if (s.modelKind) marks.push({ kind: 'model', label: '模型', title: `数据模型（${MODEL_LABELS[s.modelKind] ?? s.modelKind}）` });
  if (s.kind === 'method') marks.push({ kind: 'method', label: '方法', title: '类里定义的方法' });
  return marks;
}
