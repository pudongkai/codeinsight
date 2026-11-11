import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NavContext, type Nav } from '../src/app/nav';
import { registerPage } from '../src/bridge';
import { HOST_REVIEW_TIMEOUT_MS, HOST_TIMEOUT_NOTICE, ReviewPage } from '../src/review/ReviewPage';

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

  it('form working-tree review with a JS bridge: lets the IDE save first, then posts once with the form parameters', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      new Response(JSON.stringify(url === '/api/reviews' ? { id: 8 } : { id: 8, status: 'running' }), { status: 200 }),
    );
    const reviewWorking = vi.fn(() => {
      expect(f).not.toHaveBeenCalled();
      window.codeinsightPage!.reviewWorking();
    });
    window.codeinsightHost = { openFile: vi.fn(), reviewWorking };
    const { getByTestId } = renderReviewPage(vi.fn());
    fireEvent.change(getByTestId('review-intent'), { target: { value: 'fix orders' } });
    fireEvent.submit(getByTestId('review-form'));
    expect(reviewWorking).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(getByTestId('review-progress').textContent).toContain('审查 #8'));
    const posts = f.mock.calls.filter(([url]) => url === '/api/reviews');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]![1]!.body))).toEqual({ working: true, intent: 'fix orders' });
  });

  it('waits for the IDE after a form submit: a second submit is ignored and the form parameters are kept', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      new Response(JSON.stringify(url === '/api/reviews' ? { id: 10 } : { id: 10, status: 'running' }), { status: 200 }),
    );
    const reviewWorking = vi.fn();
    window.codeinsightHost = { openFile: vi.fn(), reviewWorking };
    const { getByTestId } = renderReviewPage(vi.fn());
    fireEvent.change(getByTestId('review-intent'), { target: { value: 'add audit log' } });
    fireEvent.submit(getByTestId('review-form'));
    expect((getByTestId('review-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(getByTestId('review-submit').textContent).toContain('等待 IDE');
    fireEvent.click(getByTestId('review-submit'));
    fireEvent.submit(getByTestId('review-form'));
    expect(reviewWorking).toHaveBeenCalledTimes(1);
    act(() => window.codeinsightPage!.reviewWorking());
    await waitFor(() => expect(getByTestId('review-progress').textContent).toContain('审查 #10'));
    const posts = f.mock.calls.filter(([url]) => url === '/api/reviews');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]![1]!.body))).toEqual({ working: true, intent: 'add audit log' });
  });

  it('frees the form with a notice when the IDE does not call back in time', () => {
    vi.useFakeTimers();
    try {
      const reviewWorking = vi.fn();
      window.codeinsightHost = { openFile: vi.fn(), reviewWorking };
      const { getByTestId, queryByTestId } = renderReviewPage(vi.fn());
      fireEvent.submit(getByTestId('review-form'));
      expect((getByTestId('review-submit') as HTMLButtonElement).disabled).toBe(true);
      act(() => vi.advanceTimersByTime(HOST_REVIEW_TIMEOUT_MS));
      expect((getByTestId('review-submit') as HTMLButtonElement).disabled).toBe(false);
      expect(getByTestId('host-timeout').textContent).toBe(HOST_TIMEOUT_NOTICE);
      fireEvent.submit(getByTestId('review-form'));
      expect(reviewWorking).toHaveBeenCalledTimes(2);
      expect(queryByTestId('host-timeout')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('commit-range review with a JS bridge posts directly', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 9 }), { status: 200 }));
    const reviewWorking = vi.fn();
    window.codeinsightHost = { openFile: vi.fn(), reviewWorking };
    const { getByTestId } = renderReviewPage(vi.fn());
    fireEvent.click(getByTestId('mode-range'));
    fireEvent.submit(getByTestId('review-form'));
    await waitFor(() => expect(f).toHaveBeenCalledWith('/api/reviews', expect.objectContaining({ body: '{"head":"HEAD"}' })));
    expect(reviewWorking).not.toHaveBeenCalled();
  });
});
