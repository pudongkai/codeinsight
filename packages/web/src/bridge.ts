/**
 * 插件注入的 JS 桥 `window.codeinsightHost`。每次点击时再检查，插件可能在页面脚本执行之后才注入。
 */
export interface CodeInsightHost {
  openFile(path: string, line: number): void;
  reviewWorking?(): void;
}

declare global {
  interface Window {
    codeinsightHost?: CodeInsightHost;
  }
}

export function hostBridge(): CodeInsightHost | undefined {
  const host = typeof window === 'undefined' ? undefined : window.codeinsightHost;
  return host && typeof host.openFile === 'function' ? host : undefined;
}

/** 要打开的函数位置 */
export interface OpenTarget {
  path: string;
  line: number;
  /** removed 的函数在工作区里已不存在，不交给 IDE */
  removed?: boolean;
}

/** 有 JS 桥且不是 removed 的函数时在 IDE 里打开并返回 true；否则返回 false，由调用方在页面里显示源码 */
export function openInHost(target: OpenTarget): boolean {
  const host = hostBridge();
  if (!host || target.removed) return false;
  host.openFile(target.path, target.line);
  return true;
}
