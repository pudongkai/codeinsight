import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useNav } from '../app/nav';
import { location } from '../format';
import { useApi } from './useApi';

const DEBOUNCE_MS = 250;

/** 在当前工作区快照中按名字搜索函数；索引没建好时不可用 */
export function SearchBox({ ready }: { ready: boolean }) {
  const nav = useNav();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(text.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [text]);
  const { data, error, loading } = useApi(ready && query ? () => api.search(query) : undefined, [query, ready]);
  return (
    <section className="panel search">
      <input
        type="search" data-testid="search-input" value={text} disabled={!ready}
        placeholder={ready ? '搜索函数名' : '索引建好后才能搜索'} onChange={(e) => setText(e.target.value)}
      />
      {loading && <p className="muted">搜索中…</p>}
      {error && <div className="error">搜索失败：{error}</div>}
      {query && data && (
        <ul className="results">
          {data.results.length === 0 && <li className="muted">没有匹配的函数</li>}
          {data.results.map((s) => (
            <li key={s.id}>
              <button type="button" className="link" data-testid="search-result" data-path={s.path} onClick={() => nav.openGraph({ snapshotId: data.snapshotId, id: s.id, name: s.qualifiedName }, 'browse')}>
                {s.qualifiedName}
              </button>
              {s.isTest && <span className="tag">测试</span>} <span className="loc">{location(s.path, s.startLine)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
