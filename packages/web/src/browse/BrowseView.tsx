import { useState } from 'react';
import { useNav } from '../app/nav';
import { ShowModelsToggle, useShowModels } from '../graph/show-models';
import { Breadcrumbs, type Crumb } from './Breadcrumbs';
import { EntryList } from './EntryList';
import { NeighborGraph } from './NeighborGraph';
import type { NNode } from './neighbor-model';
import { SearchBox } from './SearchBox';
import { SymbolDetail } from './SymbolDetail';
import { useNeighborGraph } from './useNeighborGraph';

interface Props {
  currentSnapshotId: number | undefined;
  trail: Crumb[];
  onHome(): void;
  onPickCrumb(index: number): void;
}

function CenterView({ center }: { center: Crumb }) {
  const nav = useNav();
  const [showTests, setShowTests] = useState(false);
  const [showModels, setShowModels] = useShowModels();
  const { state, error, loading, expand } = useNeighborGraph(center.snapshotId, center.id, nav.snapshotGone, center.expandCallees);
  const toCenter = (n: NNode) => nav.openGraph({ snapshotId: center.snapshotId, id: n.info.id, name: n.info.qualifiedName });
  const open = (n: NNode) => nav.openSymbol({ snapshotId: center.snapshotId, id: n.info.id, name: n.info.qualifiedName, path: n.info.path, line: n.info.startLine });
  return (
    <div className="center-view">
      <div className="toolbar">
        <label>
          <input type="checkbox" data-testid="toggle-tests" checked={showTests} onChange={(e) => setShowTests(e.target.checked)} /> 显示测试代码
        </label>
        <ShowModelsToggle value={showModels} onChange={setShowModels} />
        <span className="muted">单击节点设为中心，双击查看源码，“展开”再加载一层；鼠标拖动平移，双指捏合或按住 ⌘ / Ctrl 滚动缩放</span>
      </div>
      {error && <div className="error">{error}</div>}
      {loading === 'center' && <p className="muted">加载调用关系…</p>}
      {state && <NeighborGraph state={state} showTests={showTests} showModels={showModels} loadingId={loading} onExpand={(id) => void expand(id)} onCenter={toCenter} onOpen={open} />}
      <SymbolDetail snapshotId={center.snapshotId} id={center.id} />
    </div>
  );
}

/** 浏览视图：搜索、入口列表、邻居图和面包屑 */
export function BrowseView({ currentSnapshotId, trail, onHome, onPickCrumb }: Props) {
  const center = trail.at(-1);
  return (
    <div className="browse" data-testid="browse-view">
      <SearchBox ready={currentSnapshotId !== undefined} />
      <Breadcrumbs trail={trail} onHome={onHome} onPick={onPickCrumb} />
      {center ? <CenterView key={`${center.snapshotId}:${center.id}:${center.expandCallees ?? 1}`} center={center} /> : <EntryList snapshotId={currentSnapshotId} />}
    </div>
  );
}
