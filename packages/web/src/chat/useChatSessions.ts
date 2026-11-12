import { useCallback, useState } from 'react';
import { api, ApiError, errorMessage } from '../api/client';
import type { ChatSessionDetail } from '../api/types';
import { usePolling } from '../app/usePolling';
import { useApi } from '../browse/useApi';

/** 会话正在回答（如在另一个页面提问、或刚点了停止还没保存完）时按这个间隔重新读取 */
const ANSWERING_POLL_MS = 1000;

/** 选中会话的消息：会话正在回答时轮询，直到回答保存完 */
function useSessionDetail(id: number | undefined, round: number, onLoaded: (d: ChatSessionDetail) => void) {
  const [detail, setDetail] = useState<ChatSessionDetail>();
  const [error, setError] = useState<string>();
  usePolling<ChatSessionDetail>(
    id === undefined ? undefined : {
      load: () => api.chatSession(id),
      again: (d) => d.answering,
      onData: (d) => {
        setDetail(d);
        setError(undefined);
        onLoaded(d);
      },
      onError: (err) => setError(err instanceof ApiError && err.status === 404 ? '会话已被删除' : `读取会话失败：${errorMessage(err)}`),
      intervalMs: ANSWERING_POLL_MS,
    },
    [id, round],
  );
  return { detail: detail?.id === id ? detail : undefined, error: id === undefined ? undefined : error };
}

/**
 * 会话列表和选中的会话：没选过时选最近的一个；选“新建”时还没有会话，提问时再创建。
 * reload 重新读列表和选中会话的消息。
 */
export function useChatSessions(onDetail: (d: ChatSessionDetail) => void) {
  const [round, setRound] = useState(0);
  const [picked, setPicked] = useState<number | 'new'>();
  const [actionError, setActionError] = useState<string>();
  const sessions = useApi(() => api.chatSessions(), [round]);
  const list = sessions.data?.sessions ?? [];
  const currentId = picked === 'new' ? undefined : (picked ?? list[0]?.id);
  const { detail, error } = useSessionDetail(currentId, round, onDetail);
  const reload = useCallback(() => setRound((n) => n + 1), []);
  const remove = async (id: number) => {
    setActionError(undefined);
    try {
      await api.deleteChatSession(id);
      if (picked === id) setPicked(undefined);
    } catch (err) {
      setActionError(`删除会话失败：${errorMessage(err)}`);
    }
    reload();
  };
  return {
    list, loading: sessions.loading, error: actionError ?? (sessions.error && `读取会话列表失败：${sessions.error}`),
    currentId, isNew: picked === 'new', detail, detailError: error, pick: setPicked, reload, remove,
  };
}
