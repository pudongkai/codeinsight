import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api';
import { NODE_HEIGHT, NODE_WIDTH, type GraphEdgeSpec, type GraphNodeSpec } from './types';

let elk: InstanceType<typeof ELK> | undefined;

export type Positions = Map<string, { x: number; y: number }>;

/**
 * ELK layered 布局，从左到右。给了 column 的节点按列分区，调用方固定在中心左边、被调用方在右边（有环时也不会翻到另一侧）。
 */
export async function layoutGraph(nodes: GraphNodeSpec[], edges: GraphEdgeSpec[]): Promise<Positions> {
  elk ??= new ELK();
  const partitioned = nodes.some((n) => n.column !== undefined);
  const ids = new Set(nodes.map((n) => n.id));
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '70',
      'elk.spacing.nodeNode': '18',
      'elk.partitioning.activate': partitioned ? 'true' : 'false',
    },
    children: nodes.map((n) => ({
      id: n.id, width: NODE_WIDTH, height: NODE_HEIGHT,
      ...(n.column !== undefined ? { layoutOptions: { 'elk.partitioning.partition': String(n.column) } } : {}),
    })),
    edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target)
      .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
  const out = await elk.layout(graph);
  return new Map((out.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
}
