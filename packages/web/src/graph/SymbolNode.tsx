import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { MarkTag } from '../marks/SymbolMarks';
import type { GraphNodeSpec, NodePager } from './types';

export type SymbolFlowNode = Node<{ spec: GraphNodeSpec }, 'symbol'>;

export function dataAttrs(attrs: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(attrs ?? {}).map(([k, v]) => [`data-${k}`, v]));
}

/** 悬停提示：限定名，加上各标记的说明（接口的方法和路径在这里，不占节点宽度） */
function nodeTitle(spec: GraphNodeSpec): string {
  return [spec.title ?? spec.label, ...(spec.marks ?? []).map((m) => m.title)].join('\n');
}

/** 节点内的按钮：不触发节点的单击、双击和拖拽 */
const stop = (e: React.MouseEvent) => e.stopPropagation();

/** 展开出的下一层超过一页时的翻页按钮 */
function NodePagerButtons({ pager }: { pager: NodePager }) {
  const go = (e: React.MouseEvent, page: number) => {
    e.stopPropagation();
    pager.onPage(page);
  };
  return (
    <span className="gnode-pager nodrag" data-testid="node-pager" data-total={pager.total} data-page={pager.page + 1} data-pages={pager.pages}
      title={`下一层第 ${pager.page + 1} / ${pager.pages} 页，共 ${pager.total} 个`} onDoubleClick={stop}>
      <button type="button" data-testid="node-pager-prev" disabled={pager.page === 0} onClick={(e) => go(e, pager.page - 1)}>‹</button>
      {pager.page + 1}/{pager.pages}
      <button type="button" data-testid="node-pager-next" disabled={pager.page >= pager.pages - 1} onClick={(e) => go(e, pager.page + 1)}>›</button>
    </span>
  );
}

/** 图节点：名字、类型标记、位置，可选的"展开"按钮或下一层的翻页按钮 */
export function SymbolNode({ data }: NodeProps<SymbolFlowNode>) {
  const { spec } = data;
  return (
    <div className={`gnode tone-${spec.tone}`} data-testid="graph-node" data-id={spec.id} title={nodeTitle(spec)} {...dataAttrs(spec.attrs)}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="gnode-head">
        <span className="gnode-label">{spec.label}</span>
        <span className="gnode-tags">
          {spec.marks?.map((m) => <MarkTag key={m.kind} mark={m} />)}
          {spec.tags?.map((t) => <span key={t.label} className="tag gnode-tag" title={t.title}>{t.label}</span>)}
          {spec.badge && <span className="badge">{spec.badge}</span>}
        </span>
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
          onDoubleClick={stop}
        >
          展开
        </button>
      )}
      {spec.pager && <NodePagerButtons pager={spec.pager} />}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}
