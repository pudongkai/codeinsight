import type { ReviewReport, SymbolChange } from '@codeinsight/core/report/types';
import { useMemo } from 'react';
import { FlowGraph } from '../graph/FlowGraph';
import type { SymbolTarget } from './actions';
import { buildReportGraph, MAX_GRAPH_CHANGES } from './report-graph';

interface Props {
  report: ReviewReport;
  onSelect(c: SymbolChange): void;
  onOpen(t: SymbolTarget): void;
}

/** 结构图：单击改动函数在影响面面板里查看，单击其他函数或双击任意函数查看源码 */
export function StructureGraph({ report, onSelect, onOpen }: Props) {
  const graph = useMemo(() => buildReportGraph(report), [report]);
  if (graph.nodes.length === 0) return null;
  const click = (id: string) => {
    const t = graph.targets.get(id);
    if (t?.change) onSelect(t.change);
    else if (t) onOpen(t.target);
  };
  const dbl = (id: string) => {
    const t = graph.targets.get(id);
    if (t) onOpen(t.target);
  };
  return (
    <section className="panel" data-testid="structure-graph">
      <h3>结构图</h3>
      <p className="muted legend">
        <span className="lg added">新增</span> <span className="lg modified">修改</span> <span className="lg removed">删除</span>{' '}
        <span className="lg moved">搬家</span> 绿色边为新增调用，红色虚线为删除的调用，灰色为已有调用方。
        {graph.omitted > 0 && ` 只显示调用方最多的 ${MAX_GRAPH_CHANGES} 个改动函数，另有 ${graph.omitted} 个见改动清单。`}
      </p>
      <FlowGraph nodes={graph.nodes} edges={graph.edges} onNodeClick={click} onNodeDoubleClick={dbl} height={420} />
    </section>
  );
}
