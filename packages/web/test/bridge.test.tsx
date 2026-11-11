import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NavContext, type Nav } from '../src/app/nav';
import { registerPage } from '../src/bridge';
import { ReviewPage } from '../src/review/ReviewPage';

const nav: Nav = { openSymbol: vi.fn(), showSource: vi.fn(), openGraph: vi.fn(), snapshotGone: vi.fn(), indexNotReady: vi.fn() };

function renderReviewPage(onHostReview: () => void) {
  return render(
    <NavContext.Provider value={nav}>
      <ReviewPage status={undefined} refreshStatus={() => undefined} goneNotice={false} resetGone={() => undefined} onHostReview={onHostReview} />
    </NavContext.Provider>,
  );
}

afterEach(() => {
  delete window.codeinsightPage;
  delete window.codeinsightPendingReviewWorking;
});

describe('page entry for the IDE plugin', () => {
  it('replays a request that arrived before the page registered, and unregisters only itself', () => {
    window.codeinsightPendingReviewWorking = true;
    const reviewWorking = vi.fn();
    const unregister = registerPage({ reviewWorking });
    expect(reviewWorking).toHaveBeenCalledTimes(1);
    expect(window.codeinsightPendingReviewWorking).toBeUndefined();
    const other = { reviewWorking: vi.fn() };
    window.codeinsightPage = other;
    unregister();
    expect(window.codeinsightPage).toBe(other);
  });

  it('reviewWorking() starts a working-tree review, switches to the review tab and shows its progress', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      new Response(JSON.stringify(url === '/api/reviews' ? { id: 7 } : { id: 7, status: 'running', progress: 'snapshots' }), { status: 200 }),
    );
    const onHostReview = vi.fn();
    const { getByTestId } = renderReviewPage(onHostReview);
    window.codeinsightPage!.reviewWorking();
    expect(onHostReview).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(getByTestId('review-progress').textContent).toContain('审查 #7 进行中'));
    expect(f.mock.calls[0]).toEqual(['/api/reviews', expect.objectContaining({ method: 'POST', body: '{"working":true}' })]);
  });
});
