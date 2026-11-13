import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { pickErrorText } from './labels';

/** 等待超时：macOS 的选择窗口在服务端超时后仍可能开着 */
export const PICK_TIMEOUT_TEXT = '等待选择超时；如果选择窗口还开着，请先在窗口里选择或取消';

/**
 * “选择目录…”：服务端弹出系统选择文件夹窗口，选中后把路径交给 onPicked；
 * 等待期间 waiting 为 true，取消不提示错误。组件卸载（关掉弹窗）时中止请求，服务端随之结束弹窗。
 */
export function usePickDir(onPicked: (path: string) => void) {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string>();
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), []);
  const pick = async () => {
    const ac = new AbortController();
    controller.current = ac;
    setWaiting(true);
    setError(undefined);
    try {
      const r = await api.pickDir(ac.signal);
      if (r.status === 'selected') onPicked(r.path);
      if (r.status === 'timeout') setError(PICK_TIMEOUT_TEXT);
    } catch (err) {
      if (!ac.signal.aborted) setError(pickErrorText(err));
    } finally {
      if (!ac.signal.aborted) setWaiting(false);
    }
  };
  return { waiting, error, pick };
}
