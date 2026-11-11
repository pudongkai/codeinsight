import { Background, Controls, MarkerType, ReactFlow, useReactFlow, useStore, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useRef } from 'react';
import { SymbolNode, type SymbolFlowNode } from './SymbolNode';
import type { EdgeTone, GraphEdgeSpec, GraphNodeSpec } from './types';
import { useLayout } from './useLayout';

const NODE_TYPES = { symbol: SymbolNode };

const EDGE_STYLES: Record<EdgeTone, React.CSSProperties> = {
  normal: { stroke: '#94a3b8', strokeWidth: 1.2 },
  added: { stroke: '#16a34a', strokeWidth: 2 },
  removed: { stroke: '#dc2626', strokeWidth: 2, strokeDasharray: '6 4' },
};

/** 单击与双击区分开：单击延迟执行，期间发生双击则取消 */
const CLICK_DELAY_MS = 250;

interface Props {
  nodes: GraphNodeSpec[];
  edges: GraphEdgeSpec[];
  height?: number;
  onNodeClick?: (id: string) => void;
  onNodeDoubleClick?: (id: string) => void;
  testId?: string;
}

function useClickHandlers(onClick?: (id: string) => void, onDouble?: (id: string) => void) {
  const timer = useRef<number | undefined>(undefined);
  return {
    click: (id: string) => {
      if (!onClick) return;
      if (!onDouble) return onClick(id);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => onClick(id), CLICK_DELAY_MS);
    },
    double: (id: string) => {
      window.clearTimeout(timer.current);
      onDouble?.(id);
    },
  };
}

const FIT_OPTIONS = { padding: 0.15, maxZoom: 1.2 };

/** 容器尺寸变化（如打开源码面板）后重新适配视野 */
function FitOnResize() {
  const { fitView } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  useEffect(() => {
    void fitView(FIT_OPTIONS);
  }, [width, height, fitView]);
  return null;
}

/** React Flow + ELK 渲染的调用图（报告结构图和浏览邻居图共用） */
export function FlowGraph({ nodes, edges, height = 460, onNodeClick, onNodeDoubleClick, testId }: Props) {
  const { positions, version, error } = useLayout(nodes, edges);
  const handlers = useClickHandlers(onNodeClick, onNodeDoubleClick);
  const flowNodes = useMemo<SymbolFlowNode[]>(
    () => nodes.map((n) => ({ id: n.id, type: 'symbol', position: positions?.get(n.id) ?? { x: 0, y: 0 }, data: { spec: n }, draggable: false })),
    [nodes, positions],
  );
  const flowEdges = useMemo<Edge[]>(
    () => edges.map((e) => ({
      id: e.id, source: e.source, target: e.target, style: EDGE_STYLES[e.tone],
      markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_STYLES[e.tone].stroke as string },
    })),
    [edges],
  );
  return (
    <div className="graph" style={{ height }} data-testid={testId} data-node-count={nodes.length}>
      {error && <div className="error">{error}</div>}
      {positions && (
        <ReactFlow
          key={version}
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={FIT_OPTIONS}
          minZoom={0.1}
          nodesConnectable={false}
          onNodeClick={(_, n) => handlers.click(n.id)}
          onNodeDoubleClick={(_, n) => handlers.double(n.id)}
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} color="#e2e8f0" />
          <Controls showInteractive={false} />
          <FitOnResize />
        </ReactFlow>
      )}
    </div>
  );
}
