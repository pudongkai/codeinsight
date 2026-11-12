import type { OverviewModule } from '@codeinsight/core/overview/types';
import { AiStatusTag } from './parts';

interface Props {
  modules: OverviewModule[];
  issueCounts: Map<string, number>;
  selected?: string;
  onSelect(id: string): void;
}

/** 左侧模块列表：名称、id、规模、边界问题数和 AI 说明状态 */
export function ModuleList({ modules, issueCounts, selected, onSelect }: Props) {
  return (
    <section className="panel module-list" data-testid="module-list">
      <h3>模块（{modules.length}）</h3>
      <ul>
        {modules.map((m) => {
          const issues = issueCounts.get(m.id) ?? 0;
          return (
            <li key={m.id} className={m.id === selected ? 'selected' : ''} data-testid="module-item" data-id={m.id} onClick={() => onSelect(m.id)}>
              <div><strong>{m.name}</strong> <AiStatusTag status={m.aiStatus} /></div>
              <div className="mod-id">{m.id}</div>
              <div className="muted">
                规模 {m.size}
                {issues > 0 && <span className="issue-warning"> · {issues} 个边界问题</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
