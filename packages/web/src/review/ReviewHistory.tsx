import type { ReviewSummary } from '../api/types';
import { formatTime } from '../format';

function describe(r: ReviewSummary): string {
  const p = r.params;
  if (p.head) return `${p.base ?? `${p.head}~1`}..${p.head}`;
  return `工作区（相对 ${p.base ?? 'HEAD'}）`;
}

const STATUS = { running: '进行中', done: '完成', failed: '失败' } as const;

/** 最近的审查（serve 重启后仍在） */
export function ReviewHistory({ reviews, currentId, onOpen }: { reviews: ReviewSummary[]; currentId?: number; onOpen(id: number): void }) {
  if (reviews.length === 0) return null;
  return (
    <section className="panel" data-testid="review-history">
      <h3>最近的审查</h3>
      <ul>
        {reviews.map((r) => (
          <li key={r.id} className={r.id === currentId ? 'selected' : undefined}>
            <button type="button" className="link" onClick={() => onOpen(r.id)}>#{r.id} {describe(r)}</button>{' '}
            <span className={`tag status-${r.status}`}>{STATUS[r.status]}</span> <span className="muted">{formatTime(r.createdAt)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
