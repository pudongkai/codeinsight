/** 概览页各面板共用的小组件：符号链接、示例调用点、AI 状态标签 */
import type { EdgeSample, ModuleAiStatus } from '@codeinsight/core/overview/types';
import type { SymbolRef } from '@codeinsight/core/report/types';
import type { CurrentLinks } from '../app/useCurrentLinks';
import { location } from '../format';
import { SymbolMarks } from '../marks/SymbolMarks';
import { AI_STATUS } from './labels';

/** 符号名（点击打开源码）、类型标记、位置，可选“调用关系”打开邻居图 */
export function SymbolEntry({ symbol, links, graph }: { symbol: SymbolRef; links: CurrentLinks; graph?: boolean }) {
  return (
    <span className="symlink">
      <button type="button" className="link" data-testid="overview-symbol" data-id={symbol.id} onClick={() => links.openSymbol(symbol)}>
        {symbol.qualifiedName}
      </button>{' '}
      <SymbolMarks symbol={symbol} />
      {graph && <button type="button" className="small" data-testid="overview-graph" onClick={() => links.openGraph(symbol)}>调用关系</button>}
      <span className="loc">{location(symbol.path, symbol.startLine)}</span>
    </span>
  );
}

/** 示例调用点：调用方 → 被调用方，点击位置打开源码并定位到行 */
export function SampleList({ samples, links }: { samples: EdgeSample[]; links: CurrentLinks }) {
  if (samples.length === 0) return <p className="muted">没有示例调用点（只有 import）。</p>;
  return (
    <ul>
      {samples.map((s, i) => (
        <li key={i}>
          <code>{s.src.qualifiedName}</code> → <code>{s.dst.qualifiedName}</code>{' '}
          <button type="button" className="link loc" data-testid="sample-location" onClick={() => links.openSourceAt(s.path, s.line)}>
            {location(s.path, s.line)}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function AiStatusTag({ status }: { status: ModuleAiStatus }) {
  const s = AI_STATUS[status];
  return <span className={`tag ai-status${s.problem ? ' problem' : ''}`} data-testid="ai-status" data-status={status} title={s.title}>{s.label}</span>;
}
