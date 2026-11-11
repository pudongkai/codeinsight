import type { Warning } from '@codeinsight/core/report/types';

export function WarningsPanel({ warnings }: { warnings: Warning[] }) {
  if (warnings.length === 0) return null;
  return (
    <section className="panel" data-testid="warnings-panel">
      <h3>提示（{warnings.length}）</h3>
      <ul className="warnings">
        {warnings.map((w, i) => (
          <li key={i} className={`warn-${w.level}`}>
            <code>{w.code}</code>
            {w.side && <span className="tag">{w.side}</span>}
            {w.path && <code className="loc">{w.path}</code>} {w.message}
          </li>
        ))}
      </ul>
    </section>
  );
}
