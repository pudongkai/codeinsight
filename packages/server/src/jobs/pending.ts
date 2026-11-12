/** 进行中的异步工作；关闭服务前 drain 等它们全部结束，避免关库后再写库 */
export class PendingSet {
  private readonly items = new Set<Promise<unknown>>();

  /** 登记 p，结束（成功或失败）后自动移除；返回值与 p 的结果相同 */
  track<T>(p: Promise<T>): Promise<T> {
    const tracked = p.finally(() => this.items.delete(tracked));
    this.items.add(tracked);
    return tracked;
  }

  get size(): number {
    return this.items.size;
  }

  /** 等当前登记的全部结束，失败的也算结束 */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.items]);
  }
}
