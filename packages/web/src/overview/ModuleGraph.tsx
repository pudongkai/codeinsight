import type { OverviewReport } from '@codeinsight/core/overview/types';
import { useMemo, useState } from 'react';
import { FlowGraph } from '../graph/FlowGraph';
import { useFullscreen } from '../graph/useFullscreen';
import { buildModuleGraph, MAX_GRAPH_MODULES } from './module-graph';

interface Props {
  report: OverviewReport;
  selected?: string;
  onSelectModule(id: string): void;
  onSelectEdge(id: string): void;
}

/** 模块依赖图：边粗细按权重，循环依赖红色、跨层调用橙色；点击节点看模块详情，点击边看示例调用点；可全屏显示 */
export function ModuleGraph({ report, selected, onSelectModule, onSelectEdge }: Props) {
  const [showAll, setShowAll] = useState(false);
  const graph = useMemo(() => buildModuleGraph(report, { showAll, selected }), [report, showAll, selected]);
  const large = report.modules.length > MAX_GRAPH_MODULES;
  const fs = useFullscreen<HTMLElement>();
  const full = fs.mode !== 'none';
  return (
    <section ref={fs.ref} className={`module-graph-panel${full ? ' fullscreen' : ''}`} data-testid="module-graph-panel" data-fullscreen={fs.mode}>
      <div className="module-graph-head">
        <p className="muted legend">
          边越粗表示调用越多；<span className="lg cycle">红色</span>为循环依赖，<span className="lg layer">橙色</span>为跨层调用。点击模块查看详情，点击边查看示例调用点。
          {large && (
            <label className="graph-toggle">
              {' '}<input type="checkbox" data-testid="toggle-all-modules" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> 显示全部 {report.modules.length} 个模块
            </label>
          )}
          {graph.hiddenModules > 0 && ` 已隐藏 ${graph.hiddenModules} 个没有边界问题、也不在权重前 ${MAX_GRAPH_MODULES} 的边上的模块。`}
        </p>
        <button type="button" className="small" data-testid="module-graph-fullscreen" title={full ? '退出全屏（Esc）' : '全屏显示模块图'} onClick={fs.toggle}>
          {full ? '退出全屏' : '⛶ 全屏'}
        </button>
      </div>
      <FlowGraph nodes={graph.nodes} edges={graph.edges} onNodeClick={onSelectModule} onEdgeClick={onSelectEdge} height={460} testId="module-graph" />
    </section>
  );
}
