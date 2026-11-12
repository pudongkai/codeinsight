import type { ModuleEdge, OverviewReport } from '@codeinsight/core/overview/types';
import type { CurrentLinks } from '../app/useCurrentLinks';
import { SampleList } from './parts';

/** 模块边的详情：两端模块、调用数、依赖类型和示例调用点 */
export function EdgeDetail({ report, edge, links, onSelectModule }: { report: OverviewReport; edge: ModuleEdge; links: CurrentLinks; onSelectModule(id: string): void }) {
  const name = (id: string) => report.modules.find((m) => m.id === id)?.name ?? id;
  const end = (id: string) => <button type="button" className="link" onClick={() => onSelectModule(id)}>{name(id)}</button>;
  return (
    <section className="panel" data-testid="edge-detail" data-from={edge.from} data-to={edge.to}>
      <h3>{end(edge.from)} → {end(edge.to)}</h3>
      <p className="muted">
        {edge.weight} 处调用或引用 · 依赖方式：{edge.kinds.join('、')}
        {edge.inCycle && <span className="issue-warning"> · 在循环依赖中</span>}
      </p>
      <h4>示例调用点</h4>
      <SampleList samples={edge.samples} links={links} />
    </section>
  );
}
