import type { ProposalRow } from '../store/proposals.js';
import type { ProposedFile } from './build-proposal.js';
import { normalizeSegment } from './write-scope.js';

/** 比较同一文件用的键：每段按写入检查的规则规范化（不区分大小写等） */
export function pathKey(rel: string): string {
  return rel.split('/').map(normalizeSegment).join('/');
}

/** 一组要一起确认的修改（一张卡片）里共有的部分 */
interface GroupBase {
  /** 本份记录里的编号，合并后换新编号 */
  id: number;
  /** 按 pathKey 存的文件，内容已按调用顺序叠加 */
  files: Map<string, ProposedFile>;
  /** 并入的本次问答里的写调用编号（change #N） */
  changes: number[];
  /** 并入的同会话里还在等确认的记录 id，保存时这些记录改为 dismissed */
  priorIds: number[];
}

export interface FilesGroup extends GroupBase {
  root: string;
  rootPath: string;
  summaries: string[];
}

export interface PullRequestGroup extends GroupBase {
  branch: string;
  base: string;
  source: 'edits' | 'working_tree';
  startCommit: string;
}

/** 一次调用成功后它所在的组：合并掉了哪些组、并入了哪些前面的调用和已保存的记录 */
export interface MergeInfo {
  /** 这次调用的编号（本次问答里第几次成功的写调用） */
  change: number;
  group: number;
  absorbed: number[];
  mergedChanges: number[];
  priorIds: number[];
}

/**
 * 一次问答内写工具已生成的结果，按卡片分组：后一次调用涉及前面某组的文件（同一写入根目录和路径）时，
 * 把那一组整个并进来，文件取并集、内容按调用顺序叠加，一张卡片就是一组完整的修改；同一分支的 PR 同理。
 * 同会话里还在等确认的修改也作为已有的组参与合并。工具执行时（serve 进程或 MCP 子进程）和保存时各用一份，
 * 按调用顺序记录，两边的结果一致。写调用经 serial 排队，并发的调用也按到达顺序生效
 */
export class ProposalDrafts {
  private nextId = 1;
  private changeCount = 0;
  private readonly fileGroups = new Map<number, FilesGroup>();
  private readonly fileIndex = new Map<string, number>();
  private readonly prs = new Map<string, PullRequestGroup>();
  private queue: Promise<unknown> = Promise.resolve();
  private pendingLoaded = false;

  /** 按到达顺序一个一个执行 */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** 同会话里还在等确认的修改作为已有的组；只在第一次调用时读一次 */
  loadPending(read: () => ProposalRow[]): void {
    if (this.pendingLoaded) return;
    this.pendingLoaded = true;
    for (const row of read()) {
      const base = { id: this.nextId++, files: byKey(row.payload.files ?? []), changes: [], priorIds: [row.id] };
      if (row.kind === 'files') {
        this.indexFiles({ ...base, root: row.payload.root, rootPath: row.payload.rootPath, summaries: [row.payload.summary] });
      } else {
        const p = row.payload;
        this.prs.set(p.branch, { ...base, branch: p.branch, base: p.base, source: p.source, startCommit: p.startCommit });
      }
    }
  }

  /** 写入根目录下涉及这些路径的组（按建立顺序） */
  fileGroupsFor(root: string, rootPath: string, rels: readonly string[]): FilesGroup[] {
    const ids = new Set(rels.flatMap((r) => this.fileIndex.get(`${root}\0${pathKey(r)}`) ?? []));
    return [...ids].sort((a, b) => a - b).map((id) => this.fileGroups.get(id)!).filter((g) => g.rootPath === rootPath);
  }

  /** 一次 files 调用全部成功：并入的组换成新组 */
  commitFiles(next: Pick<FilesGroup, 'root' | 'rootPath' | 'files'>, summary: string, absorbed: readonly FilesGroup[]): MergeInfo {
    for (const g of absorbed) this.fileGroups.delete(g.id);
    const group: FilesGroup = { ...next, ...this.merged(absorbed), summaries: [...absorbed.flatMap((g) => g.summaries), summary] };
    this.indexFiles(group);
    return this.info(group, absorbed);
  }

  pullRequest(branch: string): PullRequestGroup | undefined {
    return this.prs.get(branch);
  }

  /** 一次 PR 调用成功：同一分支前面的组换成新组 */
  commitPullRequest(next: Omit<PullRequestGroup, keyof GroupBase> & Pick<GroupBase, 'files'>, prev: PullRequestGroup | undefined): MergeInfo {
    const absorbed = prev ? [prev] : [];
    const group: PullRequestGroup = { ...next, ...this.merged(absorbed) };
    this.prs.set(next.branch, group);
    return this.info(group, absorbed);
  }

  private merged(absorbed: readonly GroupBase[]): Pick<GroupBase, 'id' | 'changes' | 'priorIds'> {
    return { id: this.nextId++, changes: [...absorbed.flatMap((g) => g.changes), ++this.changeCount], priorIds: absorbed.flatMap((g) => g.priorIds) };
  }

  private info(group: GroupBase, absorbed: readonly GroupBase[]): MergeInfo {
    return { change: this.changeCount, group: group.id, absorbed: absorbed.map((g) => g.id), mergedChanges: group.changes.slice(0, -1), priorIds: group.priorIds };
  }

  private indexFiles(group: FilesGroup): void {
    this.fileGroups.set(group.id, group);
    for (const key of group.files.keys()) this.fileIndex.set(`${group.root}\0${key}`, group.id);
  }
}

/** 按 pathKey 建表，保持顺序 */
export function byKey(files: readonly ProposedFile[]): Map<string, ProposedFile> {
  return new Map(files.map((f) => [pathKey(f.path), f] as const));
}

/** 几个组的文件按组的顺序合在一起（后面的组里同一文件不会重复：同一文件只属于一个组） */
export function unionFiles(groups: readonly GroupBase[]): Map<string, ProposedFile> {
  return new Map(groups.flatMap((g) => [...g.files]));
}

/** 回给模型的说明：这次和哪些修改合并成了一个待确认修改 */
export function mergeNote(info: MergeInfo): string | undefined {
  const parts = [
    info.mergedChanges.length > 0 ? `earlier change ${info.mergedChanges.map((n) => `#${n}`).join(', ')}` : '',
    info.priorIds.length > 0 ? `${info.priorIds.length} pending proposal(s) from earlier answers` : '',
  ].filter(Boolean);
  if (parts.length === 0) return undefined;
  return `merged with ${parts.join(' and ')} into one proposal; the user reviews and applies them together, and the earlier ones are replaced by it`;
}
