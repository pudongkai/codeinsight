import { createContext, useContext } from 'react';

/** 打开设置对话框；页面外（单独渲染的组件、测试）没有提供时为 undefined，此时不显示“打开设置” */
export const SettingsContext = createContext<(() => void) | undefined>(undefined);

export function useOpenSettings(): (() => void) | undefined {
  return useContext(SettingsContext);
}
