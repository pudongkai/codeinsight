import { api } from '../api/client';
import type { EntryItem } from '../api/types';
import { entryLabel } from '../format';
import { useNav } from '../app/nav';
import { useApi } from './useApi';

function groupEntries(entries: EntryItem[]): [string, EntryItem[]][] {
  const groups = new Map<string, EntryItem[]>();
  for (const e of entries) {
    const k = `${e.kind} · ${e.framework}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  return [...groups.entries()];
}

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
      {groupEntries(data.entries).map(([group, list]) => (
        <div key={group}>
          <h4>{group}</h4>
          <ul>
            {list.map((e) => (
              <li key={`${e.symbol.id}:${entryLabel(e)}`}>
                <button type="button" className="link" data-testid="entry-item" onClick={() => nav.openGraph({ snapshotId: data.snapshotId, id: e.symbol.id, name: e.symbol.qualifiedName }, 'browse')}>
                  {entryLabel(e)}
                </button>{' '}
                <span className="muted">{e.symbol.qualifiedName}</span> <span className="loc">{e.symbol.path}:{e.symbol.startLine}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
