import { useEffect, useRef } from 'react';
import type { SymbolInfo } from '../api/types';
import { location } from '../format';
import { splitLine, type CallSite } from './call-sites';
import { useSource, type LoadedSource, type SourceTarget } from './useSource';

interface Props {
  target: SourceTarget;
  onNavigate(snapshotId: number, symbol: SymbolInfo): void;
  onClose(): void;
  onGone(): void;
}

interface LineProps {
  no: number;
  text: string;
  sites: CallSite[];
  highlighted: boolean;
  onClick(s: CallSite): void;
}

function SourceLine({ no, text, sites, highlighted, onClick }: LineProps) {
  return (
    <div className={highlighted ? 'src-line hl' : 'src-line'} data-line={no} data-highlight={highlighted || undefined}>
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

/** 按路径打开时只显示目标行附近的片段，说明显示范围；目标行超出文件时说明显示的是末尾 */
function ExcerptNote({ data }: { data: LoadedSource }) {
  const { start, end, totalLines } = data.source;
  if (data.beyondEnd) {
    return <p className="warn" data-testid="source-excerpt">目标行（第 {data.beyondEnd.line} 行）超出文件范围（文件共 {totalLines} 行），显示文件末尾第 {start}–{end} 行</p>;
  }
  if (data.symbol || (start <= 1 && end >= totalLines)) return null;
  return <p className="muted" data-testid="source-excerpt">只显示目标行附近的片段：第 {start}–{end} 行（文件共 {totalLines} 行）</p>;
}

function title(data: LoadedSource | undefined): string {
  if (!data) return '源码';
  if (data.symbol) return `${data.symbol.qualifiedName}  ${location(data.symbol.path, data.symbol.startLine)}`;
  return location(data.source.path, data.highlight?.start ?? data.source.start);
}

/** 按路径打开时把目标行滚到面板中间 */
function useScrollToHighlight(data: LoadedSource | undefined) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const line = ref.current?.querySelector('[data-highlight]');
    // jsdom 没有 scrollIntoView
    if (line && 'scrollIntoView' in line) line.scrollIntoView({ block: 'center' });
  }, [data]);
  return ref;
}

/** 源码面板：显示整个函数（项目内调用加下划线，点击跳到被调用函数的邻居图），或整个文件并突出显示目标行 */
export function SourcePanel({ target, onNavigate, onClose, onGone }: Props) {
  const { data, error, loading } = useSource(target, onGone);
  const ref = useScrollToHighlight(data);
  const lines = data?.source.content.split('\n') ?? [];
  const hl = data?.highlight;
  return (
    <aside className="panel source-panel" data-testid="source-panel">
      <div className="panel-head">
        <h3>{title(data)}</h3>
        <button type="button" className="small" onClick={onClose}>关闭</button>
      </div>
      {loading && <p className="muted">加载中…</p>}
      {error && <div className="error">读取源码失败：{error}</div>}
      {data && <ExcerptNote data={data} />}
      {data && (
        <pre className="src" data-testid="source-code" ref={ref}>
          {lines.map((text, i) => {
            const no = data.source.start + i;
            return (
              <SourceLine
                key={no} no={no} text={text} sites={data.sites.filter((s) => s.line === no)}
                highlighted={hl !== undefined && no >= hl.start && no <= hl.end}
                onClick={(s) => onNavigate(target.snapshotId, s.target)}
              />
            );
          })}
        </pre>
      )}
    </aside>
  );
}
