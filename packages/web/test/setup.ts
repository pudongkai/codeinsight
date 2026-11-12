import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// 新版 Node 自带的全局 localStorage（未指定存储文件时为 undefined）会挡住 jsdom 的，这里换回 jsdom 的实现
const jsdomStorage = (globalThis as { jsdom?: { window: Window } }).jsdom?.window.localStorage;
if (jsdomStorage && !globalThis.localStorage) {
  Object.defineProperty(globalThis, 'localStorage', { value: jsdomStorage, configurable: true });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.codeinsightHost;
});
