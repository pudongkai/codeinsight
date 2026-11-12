import { Controls, MarkerType, ReactFlow, useReactFlow, useStore, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { dataAttrs, SymbolNode, type SymbolFlowNode } from './SymbolNode';
import type { EdgeTone, GraphEdgeSpec, GraphNodeSpec } from './types';
import { useLayout } from './useLayout';

const NODE_TYPES = { symbol: SymbolNode };

const EDGE_STYLES: Record<EdgeTone, React.CSSProperties> = {
  normal: { stroke: '#94a3b8', strokeWidth: 1.2 },
  added: { stroke: '#16a34a', strokeWidth: 2 },
  removed: { stroke: '#dc2626', strokeWidth: 2, strokeDasharray: '6 4' },
  cycle: { stroke: '#dc2626', strokeWidth: 2 },
  layer: { stroke: '#ea580c', strokeWidth: 2 },
};

function flowEdge(e: GraphEdgeSpec): Edge {
  const base = EDGE_STYLES[e.tone];
  return {
    id: e.id, source: e.source, target: e.target, style: e.width ? { ...base, strokeWidth: e.width } : base,
    markerEnd: { type: MarkerType.ArrowClosed, color: base.stroke as string },
    domAttributes: { 'data-testid': 'graph-edge', 'data-tone': e.tone, ...dataAttrs(e.attrs) } as Edge['domAttributes'],
  };
}

/** 单击与双击区分开：单击延迟执行，期间发生双击则取消 */
const CLICK_DELAY_MS = 250;

interface Props {
  nodes: GraphNodeSpec[];
  edges: GraphEdgeSpec[];
  height?: number;
  onNodeClick?: (id: string) => void;
  onNodeDoubleClick?: (id: string) => void;
  onEdgeClick?: (id: string) => void;
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

/**
 * 触控板操作：双指捏合缩放（Chrome / JCEF 里捏合是带 ctrlKey 的 wheel 事件），双指滑动不移动图，
 * 交给页面正常滚动；按住 ⌘ / Ctrl 再滚动也缩放，给鼠标滚轮用户和收不到捏合事件的环境用。鼠标拖拽平移。
 */
const TRACKPAD_GESTURES = {
  panOnScroll: false,
  zoomOnScroll: false,
  preventScrolling: false,
  zoomOnPinch: true,
  zoomActivationKeyCode: ['Meta', 'Control'],
  panOnDrag: true,
};

/**
 * 平移、缩放期间把视口放进单独的合成层，每帧只移动已画好的层，不重画节点和边；
 * 结束后撤掉，让文字按新的缩放比例重新清晰绘制。直接改 DOM 属性，不触发 React 重渲染。
 */
function useMovingFlag() {
  const ref = useRef<HTMLDivElement>(null);
  const start = useCallback(() => ref.current?.setAttribute('data-moving', ''), []);
  const end = useCallback(() => ref.current?.removeAttribute('data-moving'), []);
  return { ref, start, end };
}

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

/**
 * React Flow + ELK 渲染的调用图（报告结构图和浏览邻居图共用）。
 * 不画点阵背景：点阵跟着平移缩放每帧整块重画，在 IDE 内嵌的离屏渲染浏览器里拖动会明显变慢。
 */
export function FlowGraph({ nodes, edges, height = 460, onNodeClick, onNodeDoubleClick, onEdgeClick, testId }: Props) {
  const { positions, version, error } = useLayout(nodes, edges);
  const handlers = useClickHandlers(onNodeClick, onNodeDoubleClick);
  const moving = useMovingFlag();
  const flowNodes = useMemo<SymbolFlowNode[]>(
    () => nodes.map((n) => ({ id: n.id, type: 'symbol', position: positions?.get(n.id) ?? { x: 0, y: 0 }, data: { spec: n }, draggable: false })),
    [nodes, positions],
  );
  const flowEdges = useMemo<Edge[]>(() => edges.map(flowEdge), [edges]);
  return (
    <div ref={moving.ref} className="graph" style={{ height }} data-testid={testId} data-node-count={nodes.length}>
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
          {...TRACKPAD_GESTURES}
          nodesConnectable={false}
          onNodeClick={(_, n) => handlers.click(n.id)}
          onNodeDoubleClick={(_, n) => handlers.double(n.id)}
          onEdgeClick={onEdgeClick ? (_, e) => onEdgeClick(e.id) : undefined}
          zoomOnDoubleClick={false}
          onMoveStart={moving.start}
          onMoveEnd={moving.end}
          proOptions={{ hideAttribution: true }}
        >
          <Controls showInteractive={false} />
          <FitOnResize />
        </ReactFlow>
      )}
    </div>
  );
}
