import { groupBy } from '@codeinsight/core/util/collections';
import type { NNode } from './neighbor-model';

interface Props {
  side: 'caller' | 'callee';
  nodes: NNode[];
  onPick(n: NNode): void;
  onClose(): void;
}

function groupByFile(nodes: NNode[]): [string, NNode[]][] {
  return [...groupBy(nodes, (n) => n.info.path)].sort(([a], [b]) => a.localeCompare(b));
}

/** 折叠掉的调用方 / 被调用方，按文件分组 */
export function OverflowList({ side, nodes, onPick, onClose }: Props) {
  return (
    <section className="panel" data-testid="overflow-list">
      <div className="panel-head">
        <h3>折叠的{side === 'caller' ? '调用方' : '被调用方'}（{nodes.length}）</h3>
        <button type="button" className="small" onClick={onClose}>收起</button>
      </div>
      {groupByFile(nodes).map(([file, list]) => (
        <div key={file}>
          <h4><code>{file}</code></h4>
          <ul>
            {list.map((n) => (
              <li key={n.info.id}>
                <button type="button" className="link" onClick={() => onPick(n)}>{n.info.qualifiedName}</button>{' '}
                <span className="loc">:{n.info.startLine}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
