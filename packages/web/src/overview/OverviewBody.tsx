import type { OverviewReport } from '@codeinsight/core/overview/types';
import { useMemo, useState } from 'react';
import type { CurrentLinks } from '../app/useCurrentLinks';
import { EdgeDetail } from './EdgeDetail';
import { ExternalList } from './ExternalList';
import { FeatureList } from './FeatureList';
import { IssueList } from './IssueList';
import { ModuleDetail } from './ModuleDetail';
import { ModuleGraph } from './ModuleGraph';
import { edgeId, issueCounts } from './module-graph';
import { ModuleList } from './ModuleList';

type View = 'graph' | 'features' | 'external' | 'issues';
type Selection = { kind: 'module' | 'edge'; id: string } | undefined;

const VIEWS: [View, string][] = [['graph', '模块图'], ['features', '功能'], ['external', '外部依赖'], ['issues', '边界问题']];

function SubTabs({ view, onChange, counts }: { view: View; onChange(v: View): void; counts: Record<View, number | undefined> }) {
  return (
    <nav className="subtabs">
      {VIEWS.map(([v, label]) => (
        <button key={v} type="button" className={v === view ? 'active' : ''} data-testid={`overview-view-${v}`} onClick={() => onChange(v)}>
          {label}{counts[v] !== undefined ? `（${counts[v]}）` : ''}
        </button>
      ))}
    </nav>
  );
}

/** 模块图下方：选中模块的详情或选中边的示例调用点 */
function SelectionDetail({ report, sel, links, onSelectModule }: { report: OverviewReport; sel: Selection; links: CurrentLinks; onSelectModule(id: string): void }) {
  if (sel?.kind === 'module') {
    const m = report.modules.find((x) => x.id === sel.id);
    return m ? <ModuleDetail report={report} module={m} links={links} onSelectModule={onSelectModule} /> : null;
  }
  const e = sel && report.moduleEdges.find((x) => edgeId(x) === sel.id);
  return e ? <EdgeDetail report={report} edge={e} links={links} onSelectModule={onSelectModule} /> : <p className="muted">点击模块或边查看详情。</p>;
}

/** 概览正文：左侧模块列表，右侧模块图 / 功能 / 外部依赖 / 边界问题 */
export function OverviewBody({ report, links }: { report: OverviewReport; links: CurrentLinks }) {
  const [view, setView] = useState<View>('graph');
  const [sel, setSel] = useState<Selection>();
  const counts = useMemo(() => issueCounts(report.issues), [report]);
  const selectModule = (id: string) => {
    setSel({ kind: 'module', id });
    setView('graph');
  };
  return (
    <>
      <ModuleList modules={report.modules} issueCounts={counts} selected={sel?.kind === 'module' ? sel.id : undefined} onSelect={selectModule} />
      <div className="overview-main">
        <SubTabs view={view} onChange={setView} counts={{ graph: undefined, features: report.features.length, external: report.external.length, issues: report.issues.length }} />
        <div hidden={view !== 'graph'}>
          <ModuleGraph report={report} selected={sel?.kind === 'module' ? sel.id : undefined} onSelectModule={selectModule} onSelectEdge={(id) => setSel({ kind: 'edge', id })} />
          <SelectionDetail report={report} sel={sel} links={links} onSelectModule={selectModule} />
        </div>
        {view === 'features' && <FeatureList features={report.features} modules={report.modules} links={links} />}
        {view === 'external' && <ExternalList external={report.external} modules={report.modules} />}
        {view === 'issues' && <IssueList issues={report.issues} links={links} />}
      </div>
    </>
  );
}
