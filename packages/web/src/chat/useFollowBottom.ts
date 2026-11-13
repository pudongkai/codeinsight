import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** 离底部多近算“在底部”：往下滚回这个范围内时恢复跟随 */
export const FOLLOW_THRESHOLD = 80;

interface ScrollBox {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** 滚动区域是否在底部附近 */
export function isNearBottom(box: ScrollBox, threshold = FOLLOW_THRESHOLD): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= threshold;
}

export interface FollowBottom {
  ref: RefObject<HTMLDivElement | null>;
  /** 用户停在底部附近；为 false 时显示“回到底部” */
  atBottom: boolean;
  onScroll(): void;
  /** 立即滚到底，并恢复跟随新内容 */
  jump(): void;
}

/** 内容变少时浏览器会把滚动位置往上调到新的底部，停在底部的向上滚动不算用户往上翻 */
const CLAMP_SLACK = 1;

/** 这次滚动是否为用户往上翻看 */
function scrolledUp(box: ScrollBox, lastTop: number): boolean {
  return box.scrollTop < lastTop && !isNearBottom(box, CLAMP_SLACK);
}

/**
 * 对话区自动滚到底：content 里任一项变化（新消息、流式回答增加内容）后，如果正在跟随就滚到新的底部；
 * 其他原因的重新渲染不滚动。
 * 用户一往上滚就停止跟随；之后往下滚回到底部 80px 内，或调用 jump，才恢复跟随。
 */
export function useFollowBottom(...content: unknown[]): FollowBottom {
  const ref = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const lastTop = useRef(0);
  const [atBottom, setAtBottom] = useState(true);
  const toBottom = () => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  };
  useLayoutEffect(() => {
    if (follow.current) toBottom();
  }, content);
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    follow.current = !scrolledUp(el, lastTop.current) && isNearBottom(el);
    lastTop.current = el.scrollTop;
    setAtBottom(follow.current);
  }, []);
  const jump = useCallback(() => {
    follow.current = true;
    setAtBottom(true);
    toBottom();
  }, []);
  return { ref, atBottom, onScroll, jump };
}
