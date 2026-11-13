/** 子进程被结束的原因：timeout 为超时被结束，aborted 为调用方取消 */
export type StopReason = 'timeout' | 'aborted';

/** 从 execFile 的失败里区分取消和超时；正常退出（非零退出码）时为 undefined */
export function stopReason(err: unknown, signal?: AbortSignal): StopReason | undefined {
  if (signal?.aborted) return 'aborted';
  const e = err as { killed?: boolean; signal?: string | null } | null;
  return e?.killed || e?.signal ? 'timeout' : undefined;
}

/** 给用户看的说法：取消为 cancelled，超时带上时间上限 */
export function stopReasonText(stopped: StopReason, timeoutMs: number): string {
  return stopped === 'aborted' ? 'cancelled' : `timed out after ${timeoutMs / 1000}s`;
}
