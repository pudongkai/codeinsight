/**
 * 插件注入的 JS 桥 `window.codeinsightHost`。每次点击时再检查，插件可能在页面脚本执行之后才注入。
 * `reviewWorking()` 让 IDE 先保存未保存的编辑器内容，再通过下面的 `window.codeinsightPage` 让页面发起工作区审查。
 */
export interface CodeInsightHost {
  openFile(path: string, line: number): void;
  reviewWorking?(): void;
}

/**
 * 页面提供给插件调用的入口 `window.codeinsightPage`（插件"审查未提交改动"动作调用它）。
 * 插件可能在页面脚本注册之前调用，此时插件只设置 `codeinsightPendingReviewWorking`，由页面注册时补做。
 */
export interface CodeInsightPage {
  reviewWorking(): void;
}

declare global {
  interface Window {
    codeinsightHost?: CodeInsightHost;
    codeinsightPage?: CodeInsightPage;
    codeinsightPendingReviewWorking?: boolean;
  }
}

/** 注册页面入口并补做注册前收到的请求；返回注销函数 */
export function registerPage(page: CodeInsightPage): () => void {
  window.codeinsightPage = page;
  if (window.codeinsightPendingReviewWorking) {
    delete window.codeinsightPendingReviewWorking;
    page.reviewWorking();
  }
  return () => {
    if (window.codeinsightPage === page) delete window.codeinsightPage;
  };
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
