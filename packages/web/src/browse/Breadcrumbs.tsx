export interface Crumb {
  snapshotId: number;
  id: string;
  name: string;
}

/** 浏览路径：首页（入口列表）→ 之前的中心函数 → 当前中心 */
export function Breadcrumbs({ trail, onHome, onPick }: { trail: Crumb[]; onHome(): void; onPick(index: number): void }) {
  return (
    <nav className="crumbs" data-testid="breadcrumbs">
      <button type="button" className="link" onClick={onHome}>入口列表</button>
      {trail.map((c, i) => (
        <span key={`${i}:${c.id}`}>
          {' › '}
          {i === trail.length - 1 ? <strong>{c.name}</strong> : <button type="button" className="link" onClick={() => onPick(i)}>{c.name}</button>}
        </span>
      ))}
    </nav>
  );
}
