import { INTENT_SKIP_CODES, type ReviewReport, type SymbolRef } from '@codeinsight/core/report/types';
import type { SymbolTarget } from './actions';
import { changeTarget, refTarget } from './report-graph';
import { SymbolLink } from './SymbolLink';

const VERDICTS = { mentioned: '意图中提到', unmentioned: '意图中未提到', unclear: '不确定' } as const;
const SKIP_CODES = new Set<string>(INTENT_SKIP_CODES);

/** 意图检查里的函数都是改动函数：按 key 找到对应改动，被删除的函数要打开 base 版本 */
function intentTargets(report: ReviewReport): (r: SymbolRef) => SymbolTarget {
  const changes = new Map(report.modules.flatMap((m) => m.symbols).map((c) => [c.key, c]));
  return (r) => {
    const c = changes.get(r.key);
    return c ? changeTarget(c) : refTarget(r, 'head');
  };
}

/** 意图偏离：LLM 分组结果；没做检查时说明原因 */
export function IntentPanel({ report, onOpen }: { report: ReviewReport; onOpen(t: SymbolTarget): void }) {
  const findings = report.intentCheck;
  const targetOf = intentTargets(report);
  const reasons = report.warnings.filter((w) => SKIP_CODES.has(w.code));
  return (
    <section className="panel" data-testid="intent-panel">
      <h3>意图偏离</h3>
      {!findings && <p className="muted">未做意图检查。{reasons.map((w) => w.message).join(' ')}</p>}
      {findings?.map((f, i) => (
        <div key={i} className={`intent verdict-${f.verdict}`}>
          <span className={`badge verdict-${f.verdict}`}>{VERDICTS[f.verdict]}</span> <span>{f.summary}</span>
          {f.modules.length > 0 && <div className="muted">模块：{f.modules.join('、')}</div>}
          <ul>
            {f.symbols.map((s) => <li key={s.key}><SymbolLink target={targetOf(s)} onOpen={onOpen} /></li>)}
          </ul>
        </div>
      ))}
    </section>
  );
}
