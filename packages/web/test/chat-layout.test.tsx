import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isNearBottom, useFollowBottom } from '../src/chat/useFollowBottom';
import { readStoredFlag, useStoredFlag, writeStoredFlag } from '../src/stored-flag';

afterEach(() => localStorage.clear());

const KEY = 'codeinsight.test.flag';

describe('stored flag', () => {
  it('reads the default until written, then reads back what was written', () => {
    expect(readStoredFlag(KEY, false)).toBe(false);
    expect(readStoredFlag(KEY, true)).toBe(true);
    writeStoredFlag(KEY, true);
    expect(localStorage.getItem(KEY)).toBe('true');
    expect(readStoredFlag(KEY, false)).toBe(true);
    writeStoredFlag(KEY, false);
    expect(readStoredFlag(KEY, true)).toBe(false);
  });

  it('uses the default for unknown values and when localStorage is unavailable', () => {
    localStorage.setItem(KEY, 'yes');
    expect(readStoredFlag(KEY, false)).toBe(false);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(readStoredFlag(KEY, true)).toBe(true);
    expect(() => writeStoredFlag(KEY, false)).not.toThrow();
  });

  it('the hook keeps the value in the page even when it cannot be stored', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    function Toggle() {
      const [on, set] = useStoredFlag(KEY, false);
      return <button type="button" data-testid="flag" onClick={() => set(!on)}>{String(on)}</button>;
    }
    render(<Toggle />);
    fireEvent.click(screen.getByTestId('flag'));
    expect(screen.getByTestId('flag').textContent).toBe('true');
  });
});

describe('isNearBottom', () => {
  it('is true within 80px of the bottom and false further up', () => {
    expect(isNearBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
    expect(isNearBottom({ scrollTop: 520, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
    expect(isNearBottom({ scrollTop: 519, scrollHeight: 1000, clientHeight: 400 })).toBe(false);
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })).toBe(true);
  });
});

/** jsdom 不做排版：给滚动区域设上固定的可视高度和内容高度，scrollTop 可读写 */
function fakeBox(el: HTMLElement, content: { height: number }) {
  let top = 0;
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 400 });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => content.height });
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => (top = Math.min(v, content.height - 400)) });
}

/** n 是内容；other 变化只是无关的重新渲染 */
function Feed({ n, other = 0 }: { n: number; other?: number }) {
  const f = useFollowBottom(n);
  return (
    <>
      <div data-testid="box" ref={f.ref} onScroll={f.onScroll} data-other={other}>{n}</div>
      {!f.atBottom && <button type="button" data-testid="to-bottom" onClick={f.jump}>回到底部</button>}
    </>
  );
}

describe('useFollowBottom', () => {
  function setup() {
    const content = { height: 1000 };
    const r = render(<Feed n={0} />);
    const box = screen.getByTestId('box');
    fakeBox(box, content);
    const grow = (n: number, other = 0) => {
      content.height += 200;
      r.rerender(<Feed n={n} other={other} />);
    };
    const scrollTo = (top: number) => {
      box.scrollTop = top;
      fireEvent.scroll(box);
    };
    return { box, grow, scrollTo };
  }

  it('follows new content while the user is at the bottom', () => {
    const { box, grow, scrollTo } = setup();
    scrollTo(600);
    grow(1);
    expect(box.scrollTop).toBe(800);
    grow(2);
    expect(box.scrollTop).toBe(1000);
    expect(screen.queryByTestId('to-bottom')).toBeNull();
  });

  it('does not move after the user scrolls up, and the back-to-bottom button resumes following', () => {
    const { box, grow, scrollTo } = setup();
    scrollTo(100);
    expect(screen.getByTestId('to-bottom')).toBeTruthy();
    grow(1);
    expect(box.scrollTop).toBe(100);
    act(() => screen.getByTestId('to-bottom').click());
    expect(box.scrollTop).toBe(800);
    expect(screen.queryByTestId('to-bottom')).toBeNull();
    grow(2);
    expect(box.scrollTop).toBe(1000);
  });

  it('a re-render without new content does not scroll', () => {
    const { box, grow, scrollTo } = setup();
    scrollTo(600);
    grow(0, 1);
    expect(box.scrollTop).toBe(600);
    grow(1, 1);
    expect(box.scrollTop).toBe(1000);
  });

  it('scrolling up stops following even within 80px of the bottom; scrolling back down resumes', () => {
    const { box, grow, scrollTo } = setup();
    scrollTo(600);
    scrollTo(560);
    expect(screen.getByTestId('to-bottom')).toBeTruthy();
    grow(1);
    expect(box.scrollTop).toBe(560);
    scrollTo(740);
    expect(screen.queryByTestId('to-bottom')).toBeNull();
    grow(2);
    expect(box.scrollTop).toBe(1000);
  });

  it('the scroll position moving up because content shrank keeps following', () => {
    const content = { height: 1000 };
    const r = render(<Feed n={0} />);
    const box = screen.getByTestId('box');
    fakeBox(box, content);
    box.scrollTop = 600;
    fireEvent.scroll(box);
    content.height = 800;
    box.scrollTop = 400;
    fireEvent.scroll(box);
    expect(screen.queryByTestId('to-bottom')).toBeNull();
    content.height = 1200;
    r.rerender(<Feed n={1} />);
    expect(box.scrollTop).toBe(800);
  });
});
