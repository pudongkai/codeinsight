import { api } from '../api/client';
import { entryLabel, location } from '../format';
import { useNav } from '../app/nav';
import { useApi } from './useApi';

/** 中心函数的详情：位置（点击打开源码）、签名、docstring、入口、调用方和被调用方数量 */
export function SymbolDetail({ snapshotId, id }: { snapshotId: number; id: string }) {
  const nav = useNav();
  const { data, error } = useApi(() => api.symbol(snapshotId, id), [snapshotId, id]);
  if (error) return <div className="error">读取函数详情失败：{error}</div>;
  if (!data) return <p className="muted">加载中…</p>;
  const s = data.symbol;
  const open = () => nav.openSymbol({ snapshotId, id: s.id, name: s.qualifiedName, path: s.path, line: s.startLine });
  return (
    <section className="panel" data-testid="symbol-detail">
      <h3>{s.qualifiedName}</h3>
      <button type="button" className="link" data-testid="symbol-location" onClick={open}>
        {location(s.path, s.startLine)}–{s.endLine}
      </button>
      <pre className="sig">{s.name + s.displaySignature}</pre>
      {s.docstring && <pre className="doc">{s.docstring}</pre>}
      {data.entries.map((e, i) => <div key={i} className="badge entry">入口 · {entryLabel(e)}</div>)}
      <p>
        调用方 {data.callers.total}（正式 {data.callers.prod} / 测试 {data.callers.test}），被调用方 {data.callees.total}
      </p>
      {data.resolverStatus !== 'ok' && <p className="warn">该快照的调用关系解析失败，邻居图可能为空。</p>}
    </section>
  );
}
