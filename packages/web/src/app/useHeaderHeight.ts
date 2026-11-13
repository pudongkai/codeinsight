import { useLayoutEffect, useRef } from 'react';

/**
 * 量出内容区上方（顶栏加其下的提示条）实际占的高度，写到根元素的 CSS 变量 --header-h，
 * 让问答页、源码面板等按视口剩余高度排版；顶栏换行、提示条出现或消失时跟着更新。
 */
export function useHeaderHeight() {
  const header = useRef<HTMLElement>(null);
  const notices = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const update = () => {
      if (main.current) root.style.setProperty('--header-h', `${main.current.offsetTop}px`);
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    for (const el of [header.current, notices.current]) if (el) ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--header-h');
    };
  }, []);
  return { header, notices, main };
}
