export interface Crumb {
  snapshotId: number;
  id: string;
  name: string;
  /** 打开时预先展开的被调用方层数 */
  expandCallees?: number;
}

/** 面包屑最多显示的项数，更早的折叠成省略号 */
const MAX_VISIBLE = 10;

/** 浏览路径：首页（入口列表）→ 之前的中心函数 → 当前中心 */
export function Breadcrumbs({ trail, onHome, onPick }: { trail: Crumb[]; onHome(): void; onPick(index: number): void }) {
  const hidden = Math.max(0, trail.length - MAX_VISIBLE);
  return (
    <nav className="crumbs" data-testid="breadcrumbs">
      <button type="button" className="link" onClick={onHome}>首页</button>
      {hidden > 0 && (
        <span className="muted" title={trail.slice(0, hidden).map((c) => c.name).join(' › ')}>{' › …'}</span>
      )}
      {trail.slice(hidden).map((c, j) => {
        const i = hidden + j;
        return (
          <span key={`${i}:${c.id}`}>
            {' › '}
            {i === trail.length - 1 ? <strong>{c.name}</strong> : <button type="button" className="link" onClick={() => onPick(i)}>{c.name}</button>}
          </span>
        );
      })}
    </nav>
  );
}
