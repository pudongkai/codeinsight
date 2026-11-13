/** 仓库上下文已被替换（切换仓库或关闭服务），不再开始新任务；HTTP 层转成 409 `repo_changed` */
export class RepoClosedError extends Error {
  constructor(readonly task: string) {
    super(`the repository has changed; ${task} was not started`);
  }
}

/** 任务类共用的“已关闭”标记 */
export class ClosedFlag {
  private closed = false;

  close(): void {
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 已关闭时抛 RepoClosedError */
  check(task: string): void {
    if (this.closed) throw new RepoClosedError(task);
  }
}
