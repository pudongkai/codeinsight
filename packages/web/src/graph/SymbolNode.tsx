import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { GraphNodeSpec } from './types';

export type SymbolFlowNode = Node<{ spec: GraphNodeSpec }, 'symbol'>;

function dataAttrs(attrs: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(attrs ?? {}).map(([k, v]) => [`data-${k}`, v]));
}

/** 图节点：名字、位置、标记，可选的"展开"按钮 */
export function SymbolNode({ data }: NodeProps<SymbolFlowNode>) {
  const { spec } = data;
  return (
    <div className={`gnode tone-${spec.tone}`} data-testid="graph-node" data-id={spec.id} title={spec.title ?? spec.label} {...dataAttrs(spec.attrs)}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="gnode-head">
        <span className="gnode-label">{spec.label}</span>
        {spec.badge && <span className="badge">{spec.badge}</span>}
      </div>
      {spec.sublabel && <div className="gnode-sub">{spec.sublabel}</div>}
      {spec.onExpand && (
        <button
          type="button"
          className="gnode-expand nodrag"
          data-testid="expand-node"
          onClick={(e) => {
            e.stopPropagation();
            spec.onExpand!();
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          展开
        </button>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}
