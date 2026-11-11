import type { SymbolChange } from '@codeinsight/core/report/types';
import type { SymbolTarget } from './actions';
import { CallerCounts, ChangeBadge, EntryTag } from './ChangeBadge';
import { changeTarget, refTarget } from './report-graph';
import { SymbolLink } from './SymbolLink';

interface Props {
  change?: SymbolChange;
  onOpen(t: SymbolTarget): void;
  onGraph?: (t: SymbolTarget) => void;
}

function Signature({ c }: { c: SymbolChange }) {
  if (c.displaySignatureBefore === undefined) return <code className="sig">{c.name + c.displaySignature}</code>;
  return (
    <div className="sig-diff">
      <code className="minus">- {c.name + c.displaySignatureBefore}</code>
      <code className="plus">+ {c.name + c.displaySignature}</code>
    </div>
  );
}

/** 选中的改动函数：签名、入口、调用方和影响面 */
export function ImpactPanel({ change: c, onOpen, onGraph }: Props) {
  if (!c) return <section className="panel impact" data-testid="impact-panel"><h3>影响面</h3><p className="muted">在改动清单或结构图里选择一个函数。</p></section>;
  const target = changeTarget(c);
  const side = c.change === 'removed' ? 'base' : 'head';
  return (
    <section className="panel impact" data-testid="impact-panel">
      <h3>影响面</h3>
      <div className="impact-title">
        <ChangeBadge change={c.change} /> <SymbolLink target={target} onOpen={onOpen} label={c.qualifiedName} />
        {onGraph && <button type="button" className="small" onClick={() => onGraph(target)}>邻居图</button>}
      </div>
      <Signature c={c} />
      {c.movedFrom && <p className="muted">搬自 <code>{c.movedFrom}</code></p>}
      <p><EntryTag entry={c.entry} /> <CallerCounts c={c} /></p>
      <p>影响面（向上 {c.impact.depth} 层）：正式代码 {c.impact.prod} 个，测试代码 {c.impact.test} 个</p>
      {c.callers.topProd.length > 0 && (
        <>
          <h4>主要的正式代码调用方</h4>
          <ul>
            {c.callers.topProd.map((r) => <li key={r.key}><SymbolLink target={refTarget(r, side)} onOpen={onOpen} /></li>)}
          </ul>
        </>
      )}
    </section>
  );
}
