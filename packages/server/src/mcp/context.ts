import { log } from '@codeinsight/core';
import type { SnapshotRow } from '@codeinsight/core';
import type { IndexJobs } from '../jobs/index-jobs.js';
import type { PendingSet } from '../jobs/pending.js';
import type { ServerWorkspace } from '../workspace.js';

/** 没有可复用快照时同步建索引的默认等待时间 */
export const DEFAULT_INDEX_TIMEOUT_MS = 300_000;

export interface McpContext {
  ws: ServerWorkspace;
  indexJobs: IndexJobs;
  indexTimeoutMs: number;
  /** 正在执行的工具调用，关闭服务前等它们结束 */
  pending: PendingSet;
}

export class IndexTimeoutError extends Error {}

/**
 * 当前工作区的快照：走快照构建流水线（可复用时直接返回），同一时间只建一次。
 * 超时抛 IndexTimeoutError（建索引在后台继续，下次调用复用同一个任务），建索引失败也抛错，不返回空结果。
 */
export async function ensureWorkspaceSnapshot(ctx: McpContext): Promise<SnapshotRow> {
  const job = ctx.indexJobs.start('mcp');
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      log.warn('mcp_index_timeout', { jobId: job.id, timeoutMs: ctx.indexTimeoutMs });
      reject(new IndexTimeoutError(
        `Indexing the working tree did not finish within ${ctx.indexTimeoutMs / 1000}s. It keeps running in the background; call the tool again later.`,
      ));
    }, ctx.indexTimeoutMs);
  });
  try {
    const done = await Promise.race([job.done, timeout]);
    if (done.status === 'failed') throw new Error(`Indexing the working tree failed: ${done.error}`);
    return ctx.ws.store.getSnapshot(done.snapshotId!)!;
  } finally {
    clearTimeout(timer);
  }
}
