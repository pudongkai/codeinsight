import { useState } from 'react';

/** 读 localStorage 里的布尔开关；没存过、值不认识或 localStorage 不可用（如某些离线打开的 HTML 报告）时用默认值 */
export function readStoredFlag(key: string, fallback: boolean): boolean {
  try {
    const v = window.localStorage.getItem(key);
    if (v === 'true') return true;
    if (v === 'false') return false;
  } catch {
    // 读不了按默认值处理
  }
  return fallback;
}

export function writeStoredFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // 存不了就只在本次页面里生效
  }
}

/** 记在 localStorage 里的布尔开关：初值从存储读，修改时同时写回 */
export function useStoredFlag(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => readStoredFlag(key, fallback));
  const set = (v: boolean) => {
    setValue(v);
    writeStoredFlag(key, v);
  };
  return [value, set];
}
