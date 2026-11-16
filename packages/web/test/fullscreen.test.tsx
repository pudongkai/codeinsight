import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFullscreen } from '../src/graph/useFullscreen';

function Box() {
  const fs = useFullscreen<HTMLDivElement>();
  return (
    <div ref={fs.ref} data-testid="box" data-mode={fs.mode}>
      <button type="button" onClick={fs.toggle}>toggle</button>
    </div>
  );
}

const mode = () => screen.getByTestId('box').getAttribute('data-mode');

/** jsdom 没有 Fullscreen API：测试里按需定义，结束后删掉 */
function defineDocument(name: string, get: () => unknown) {
  Object.defineProperty(document, name, { configurable: true, get });
}

afterEach(() => {
  for (const name of ['fullscreenEnabled', 'fullscreenElement', 'exitFullscreen']) delete (document as unknown as Record<string, unknown>)[name];
  delete (HTMLElement.prototype as Partial<HTMLElement>).requestFullscreen;
});

describe('useFullscreen', () => {
  it('covers the window when the Fullscreen API is unavailable; Esc or the button leaves', () => {
    render(<Box />);
    fireEvent.click(screen.getByText('toggle'));
    expect(mode()).toBe('overlay');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(mode()).toBe('none');
    fireEvent.click(screen.getByText('toggle'));
    fireEvent.click(screen.getByText('toggle'));
    expect(mode()).toBe('none');
  });

  it('uses the Fullscreen API when it is enabled, and falls back to covering the window when the request is refused', async () => {
    let current: Element | null = null;
    defineDocument('fullscreenEnabled', () => true);
    defineDocument('fullscreenElement', () => current);
    const request = vi.fn(() => {
      current = screen.getByTestId('box');
      document.dispatchEvent(new Event('fullscreenchange'));
      return Promise.resolve();
    });
    HTMLElement.prototype.requestFullscreen = request;
    const exit = vi.fn(() => {
      current = null;
      document.dispatchEvent(new Event('fullscreenchange'));
      return Promise.resolve();
    });
    defineDocument('exitFullscreen', () => exit);
    render(<Box />);
    await act(async () => fireEvent.click(screen.getByText('toggle')));
    expect(request).toHaveBeenCalledOnce();
    expect(mode()).toBe('native');
    await act(async () => fireEvent.click(screen.getByText('toggle')));
    expect(mode()).toBe('none');

    HTMLElement.prototype.requestFullscreen = vi.fn(() => Promise.reject(new Error('denied')));
    await act(async () => fireEvent.click(screen.getByText('toggle')));
    expect(mode()).toBe('overlay');
  });
});
