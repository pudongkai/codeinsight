import type { DuplicateFinding } from '@codeinsight/core/report/types';
import type { SymbolTarget } from './actions';
import { refTarget } from './report-graph';
import { SymbolLink } from './SymbolLink';

/** 重复实现：新增或搬家的函数和库里相似的已有函数 */
export function DuplicatesPanel({ duplicates, onOpen }: { duplicates: DuplicateFinding[]; onOpen(t: SymbolTarget): void }) {
  return (
    <section className="panel" data-testid="duplicates-panel">
      <h3>重复实现（{duplicates.length}）</h3>
      {duplicates.length === 0 && <p className="muted">没有发现相似的已有函数。</p>}
      {duplicates.map((d) => (
        <div key={d.symbol.key} className="dup">
          <SymbolLink target={refTarget(d.symbol, 'head')} onOpen={onOpen} />
          <ul>
            {d.candidates.map((c) => (
              <li key={c.symbol.key}>
                <span className="score">{c.score.toFixed(2)}</span> <SymbolLink target={refTarget(c.symbol, 'head')} onOpen={onOpen} />{' '}
                <span className="muted">{c.reasons.join('；')}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
