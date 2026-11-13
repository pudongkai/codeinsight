import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { log, realPathOr, repoRoot } from '@codeinsight/core';
import type { AppContext } from './http/context.js';
import { HttpError, optBool } from './http/respond.js';
import {
  cancelTasks, closeRepoContext, createRepoContext, markClosing, rememberRepo, runningTasks, type RepoContext, type RepoTask,
} from './repo-context.js';
import { closeWorkspaceStore, type ServerWorkspace } from './workspace.js';

const MAX_PATH_CHARS = 4096;

export interface OpenRepoRequest {
  path: string;
  /** 在跑的任务全部可以中止时先中止再切换 */
  cancelRunning: boolean;
}

export interface OpenRepoResult {
  repo: string;
  repoGen: number;
  dataDir: string;
  /** 与当前仓库相同，什么都没做 */
  reused: boolean;
}

/** POST /api/repo 的请求体；path 只检查类型和长度，是否绝对路径在锁定检查之后再看 */
export function parseOpenRepoBody(body: Record<string, unknown>): OpenRepoRequest {
  const p = body.path;
  if (typeof p !== 'string' || p.trim() === '') throw new HttpError(400, 'invalid_param', 'path must be a non-empty string');
  if (p.length > MAX_PATH_CHARS) throw new HttpError(400, 'invalid_param', `path must be at most ${MAX_PATH_CHARS} characters`);
  return { path: p, cancelRunning: optBool(body, 'cancelRunning') ?? false };
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  return p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p;
}

function rejected(status: number, code: string, message?: string, extra: Record<string, unknown> = {}): HttpError {
  log.warn('repo_switch_rejected', { code, ...('tasks' in extra ? { tasks: extra.tasks } : {}) });
  return new HttpError(status, code, message, extra);
}

/** 锁定时只允许当前仓库本身（字符串或真实路径相同），不探测路径是否存在 */
async function isCurrentRepo(app: AppContext, target: string): Promise<boolean> {
  const cur = app.repo?.ws.repo;
  if (cur === undefined || !path.isAbsolute(target)) return false;
  return target === cur || (await realPathOr(target)) === (await realPathOr(cur));
}

/** 目标路径所在仓库的根目录（真实路径）；路径不存在、不是目录、不在 git 仓库里时 400 */
async function locateRepo(target: string): Promise<string> {
  if (!path.isAbsolute(target)) throw rejected(400, 'invalid_param', 'path must be absolute');
  const st = await stat(target).catch(() => undefined);
  if (!st) throw rejected(400, 'path_not_found', 'path does not exist');
  if (!st.isDirectory()) throw rejected(400, 'not_directory', 'path is not a directory');
  let root: string;
  try {
    root = await repoRoot(target);
  } catch {
    throw rejected(400, 'not_git_repo', 'path is not inside a git repository');
  }
  return realPathOr(root);
}

async function ensureSeparateDataDir(cur: RepoContext | undefined, ws: ServerWorkspace): Promise<void> {
  if (!cur || (await realPathOr(cur.ws.layout.root)) !== (await realPathOr(ws.layout.root))) return;
  throw rejected(409, 'data_dir_shared', 'the new repository would use the same data directory; unset CODEINSIGHT_DATA_DIR or make it a relative path');
}

function busy(tasks: RepoTask[]): HttpError {
  return rejected(409, 'repo_busy', 'tasks are running in the current repository', { tasks });
}

/** 有任务在跑时：cancelRunning 且全部可中止就中止并再检查，否则 409 repo_busy */
async function ensureIdle(cur: RepoContext | undefined, cancelRunning: boolean): Promise<void> {
  if (!cur) return;
  for (;;) {
    const tasks = runningTasks(cur);
    if (tasks.length === 0) return;
    if (!cancelRunning || tasks.some((t) => !t.cancellable)) throw busy(tasks);
    log.info('repo_switch_cancel_tasks', { repo: cur.ws.repo, gen: cur.gen, tasks });
    await cancelTasks(cur, 'repo_switch');
  }
}

/** 后台关闭被替换的上下文；关闭服务时等它结束 */
function scheduleClose(app: AppContext, old: RepoContext): void {
  const p: Promise<void> = closeRepoContext(old, { drain: true, reason: 'repo_switch' })
    .catch((err: unknown) => log.error('repo_context_close_failed', { repo: old.ws.repo, gen: old.gen, error: (err as Error).message }))
    .finally(() => app.closingRepos.delete(p));
  app.closingRepos.add(p);
}

/** 打开新工作区、检查后替换当前上下文；没有替换时关闭新打开的 Store，当前仓库不变 */
async function switchTo(app: AppContext, root: string, cancelRunning: boolean): Promise<RepoContext> {
  const cur = app.repo;
  const dataDir = app.startup.repo === root ? app.startup.dataDir : undefined;
  const ws = await app.openWorkspace(root, dataDir);
  let next: RepoContext | undefined;
  try {
    await ensureSeparateDataDir(cur, ws);
    await ensureIdle(cur, cancelRunning);
    // 检查和替换之间没有 await，期间不会有新任务开始；替换的同时标记旧上下文，之后它不再开始新任务
    if (app.shuttingDown) throw rejected(503, 'server_closing', 'the server is shutting down');
    if (cur && runningTasks(cur).length > 0) throw busy(runningTasks(cur));
    next = createRepoContext(app, ws, 'switch');
    app.repo = next;
    if (cur) markClosing(cur);
  } finally {
    if (!next) closeWorkspaceStore(ws);
  }
  if (cur) scheduleClose(app, cur);
  return next;
}

/**
 * 打开或切换仓库（POST /api/repo）。锁定时切到别的仓库 409 `repo_locked`；与当前仓库相同时什么都不做；
 * 有任务在跑时 409 `repo_busy`；同时只允许一个切换。
 */
export async function openRepo(app: AppContext, req: OpenRepoRequest): Promise<OpenRepoResult> {
  const target = expandHome(req.path);
  if (app.locked && !(await isCurrentRepo(app, target))) throw rejected(409, 'repo_locked', 'the repository is locked for this server');
  const root = await locateRepo(target);
  const cur = app.repo;
  if (cur && root === (await realPathOr(cur.ws.repo))) {
    return { repo: cur.ws.repo, repoGen: cur.gen, dataDir: cur.ws.config.dataDir, reused: true };
  }
  if (app.switching) throw rejected(409, 'switch_in_progress', 'another repository switch is in progress');
  app.switching = true;
  const started = Date.now();
  log.info('repo_switch_start', { from: cur?.ws.repo, to: root, cancelRunning: req.cancelRunning });
  try {
    const next = await switchTo(app, root, req.cancelRunning);
    await rememberRepo(next.ws.repo);
    log.info('repo_switched', { from: cur?.ws.repo, to: next.ws.repo, gen: next.gen, ms: Date.now() - started });
    return { repo: next.ws.repo, repoGen: next.gen, dataDir: next.ws.config.dataDir, reused: false };
  } finally {
    app.switching = false;
  }
}
