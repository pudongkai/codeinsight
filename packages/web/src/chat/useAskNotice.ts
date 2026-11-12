import { useState } from 'react';
import type { StatusResponse } from '../api/types';
import { acceptNotice, noticeAccepted, type NoticeScope } from './notice';

/** 当前 LLM 配置下是否已确认过首次提示；还没拿到状态或未配置 LLM 时 scope 为 undefined，known 区分这两种 */
export function useAskNotice(status: StatusResponse | undefined) {
  const scope: NoticeScope | undefined = status?.llm ? { ...status.llm, sendSource: status.sendSource } : undefined;
  const key = scope && JSON.stringify(scope);
  // localStorage 写不进时，本次页面里仍记住已确认
  const [acceptedKey, setAcceptedKey] = useState<string>();
  const accepted = scope !== undefined && (acceptedKey === key || noticeAccepted(scope));
  const accept = () => {
    if (!scope) return;
    acceptNotice(scope);
    setAcceptedKey(key);
  };
  return { known: status !== undefined, scope, accepted, accept };
}
