import { api } from '../api/client';
import { groupBy } from '@codeinsight/core/util/collections';
import { entryLabel, location } from '../format';
import { useNav } from '../app/nav';
import { SymbolMarks } from '../marks/SymbolMarks';
import { useApi } from './useApi';

/** 入口列表，按 kind 和 framework 分组 */
export function EntryList({ snapshotId }: { snapshotId: number | undefined }) {
  const nav = useNav();
  const { data, error } = useApi(snapshotId !== undefined ? () => api.entries() : undefined, [snapshotId]);
  if (snapshotId === undefined) return null;
  if (error) return <div className="error">读取入口列表失败：{error}</div>;
  if (!data) return <p className="muted">加载入口列表…</p>;
  return (
    <section className="panel" data-testid="entry-list">
      <h3>入口（{data.entries.length}）</h3>
      {data.entries.length === 0 && <p className="muted">没有识别到入口函数。</p>}
      {[...groupBy(data.entries, (e) => `${e.kind} · ${e.framework}`)].map(([group, list]) => (
        <div key={group}>
          <h4>{group}</h4>
          <ul>
            {list.map((e) => (
              <li key={`${e.symbol.id}:${entryLabel(e)}`}>
                <button type="button" className="link" data-testid="entry-item" onClick={() => nav.openGraph({ snapshotId: data.snapshotId, id: e.symbol.id, name: e.symbol.qualifiedName }, 'browse')}>
                  {entryLabel(e)}
                </button>{' '}
                <SymbolMarks symbol={{ ...e.symbol, entry: { kind: e.kind, framework: e.framework, detail: e.detail } }} />
                <span className="muted">{e.symbol.qualifiedName}</span> <span className="loc">{location(e.symbol.path, e.symbol.startLine)}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
