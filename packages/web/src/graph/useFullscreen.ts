import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/** native：浏览器全屏；overlay：浏览器不支持或拒绝时，用固定定位铺满窗口 */
export type FullscreenMode = 'none' | 'native' | 'overlay';

/**
 * 让 ref 指向的元素全屏显示。优先用 Fullscreen API；不可用或被拒绝（如嵌在 IDE 里的页面）时改为铺满窗口。
 * 两种方式都可以按 Esc 退出。
 */
export function useFullscreen<T extends HTMLElement>(): { ref: RefObject<T | null>; mode: FullscreenMode; toggle(): void } {
  const ref = useRef<T>(null);
  const [mode, setMode] = useState<FullscreenMode>('none');

  useEffect(() => {
    const onChange = () => setMode((m) => (document.fullscreenElement === ref.current && ref.current ? 'native' : m === 'native' ? 'none' : m));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    if (mode !== 'overlay') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMode('none');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mode]);

  const toggle = useCallback(() => {
    if (mode === 'native') {
      void document.exitFullscreen();
      return;
    }
    if (mode === 'overlay') {
      setMode('none');
      return;
    }
    const el = ref.current;
    if (!el || typeof el.requestFullscreen !== 'function' || !document.fullscreenEnabled) {
      setMode('overlay');
      return;
    }
    el.requestFullscreen().catch(() => setMode('overlay'));
  }, [mode]);

  return { ref, mode, toggle };
}
