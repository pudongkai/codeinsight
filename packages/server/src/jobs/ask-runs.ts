import { log } from '@codeinsight/core';

/** 整个 serve 同时回答的问题数上限 */
export const MAX_ACTIVE_QUESTIONS = 2;

export type AskRejection = 'session_busy' | 'too_many_questions';

interface ActiveAsk {
  controller: AbortController;
  done: Promise<void>;
}

/**
 * 正在回答的问题：每个会话同时只回答一个，整个 serve 同时最多 MAX_ACTIVE_QUESTIONS 个。
 * 删除会话、客户端断开、关闭服务时通过 AbortSignal 中止回答。
 */
export class AskRuns {
  private readonly active = new Map<number, ActiveAsk>();

  /**
   * 检查并登记后同步调用 run（调用前没有 await，同一时刻的两个请求不会都通过检查）；
   * 不能开始时返回拒绝原因，不调用 run。
   */
  start(sessionId: number, run: (signal: AbortSignal) => Promise<unknown>): { ok: true; done: Promise<void> } | { ok: false; code: AskRejection } {
    const code = this.rejection(sessionId);
    if (code) {
      log.warn('ask_rejected', { sessionId, code, active: this.active.size });
      return { ok: false, code };
    }
    const controller = new AbortController();
    const done = run(controller.signal).then(
      () => undefined,
      (err: unknown) => log.error('ask_run_error', { sessionId, error: (err as Error).message.split('\n')[0] }),
    ).finally(() => this.active.delete(sessionId));
    this.active.set(sessionId, { controller, done });
    return { ok: true, done };
  }

  isAnswering(sessionId: number): boolean {
    return this.active.has(sessionId);
  }

  /** 中止这个会话正在回答的问题并等它结束（回答已保存）；没有时返回 false */
  async cancel(sessionId: number, reason: string): Promise<boolean> {
    const a = this.active.get(sessionId);
    if (!a) return false;
    log.info('ask_cancel', { sessionId, reason });
    a.controller.abort(reason);
    await a.done;
    return true;
  }

  /** 中止全部回答并等它们结束（关闭服务前用，避免关库后再写库） */
  async drain(): Promise<void> {
    const all = [...this.active.entries()];
    if (all.length > 0) log.info('ask_cancel_all', { count: all.length });
    for (const [, a] of all) a.controller.abort('server_closing');
    await Promise.all(all.map(([, a]) => a.done));
  }

  private rejection(sessionId: number): AskRejection | undefined {
    if (this.active.has(sessionId)) return 'session_busy';
    if (this.active.size >= MAX_ACTIVE_QUESTIONS) return 'too_many_questions';
    return undefined;
  }
}
