import type { SymbolInfo } from '../api/types';
import { location } from '../format';
import { splitLine, type CallSite } from './call-sites';
import { useSource, type SourceTarget } from './useSource';

interface Props {
  target: SourceTarget;
  onNavigate(snapshotId: number, symbol: SymbolInfo): void;
  onClose(): void;
  onGone(): void;
}

function SourceLine({ no, text, sites, onClick }: { no: number; text: string; sites: CallSite[]; onClick(s: CallSite): void }) {
  return (
    <div className="src-line">
      <span className="src-no">{no}</span>
      <span className="src-text">
        {splitLine(text, sites).map((seg, i) =>
          seg.site ? (
            <button key={i} type="button" className="src-call" data-testid="source-call" title={seg.site.target.qualifiedName} onClick={() => onClick(seg.site!)}>
              {seg.text}
            </button>
          ) : (
            <span key={i}>{seg.text}</span>
          ),
        )}
      </span>
    </div>
  );
}

/** 源码面板：显示整个函数，项目内调用加下划线，点击跳到被调用函数的邻居图 */
export function SourcePanel({ target, onNavigate, onClose, onGone }: Props) {
  const { data, error, loading } = useSource(target, onGone);
  const lines = data?.source.content.split('\n') ?? [];
  return (
    <aside className="panel source-panel" data-testid="source-panel">
      <div className="panel-head">
        <h3>{data ? `${data.symbol.qualifiedName}  ${location(data.symbol.path, data.symbol.startLine)}` : '源码'}</h3>
        <button type="button" className="small" onClick={onClose}>关闭</button>
      </div>
      {loading && <p className="muted">加载中…</p>}
      {error && <div className="error">读取源码失败：{error}</div>}
      {data && (
        <pre className="src" data-testid="source-code">
          {lines.map((text, i) => {
            const no = data.source.start + i;
            return <SourceLine key={no} no={no} text={text} sites={data.sites.filter((s) => s.line === no)} onClick={(s) => onNavigate(target.snapshotId, s.target)} />;
          })}
        </pre>
      )}
    </aside>
  );
}
