import { stat } from 'node:fs/promises';
import { envTurnsOff, LIMIT_ENV, loadLlmSources, log, readUserSettings, userSettingsPath, workingKeyHasChanges } from '@codeinsight/core';
import type { SnapshotRow, UserSettings } from '@codeinsight/core';
import { jobView } from '../../jobs/index-jobs.js';
import { overviewStale } from '../../jobs/overview-jobs.js';
import type { RepoContext } from '../../repo-context.js';
import type { AppContext, Route, RequestContext } from '../context.js';
import { sendJson } from '../respond.js';
import { refreshRepoConfig } from './settings.js';

/** 当前概览的摘要（不含报告正文） */
function overviewSummary(repo: RepoContext, snap: SnapshotRow | undefined): { id: number; createdAt: number; stale: boolean } | null {
  const row = repo.ws.store.overviews.current('working', { withResult: false }).overview;
  return row ? { id: row.id, createdAt: row.createdAt, stale: overviewStale(row, snap) } : null;
}

function snapshotView(snap: SnapshotRow | undefined) {
  if (!snap) return null;
  return {
    id: snap.id, kind: snap.kind, commitSha: snap.commitSha, contentKey: snap.contentKey, createdAt: snap.createdAt,
    resolverStatus: snap.resolverStatus, resolverError: snap.resolverError,
    dirty: snap.kind === 'working' && workingKeyHasChanges(snap.contentKey),
  };
}

/** 和仓库有关的字段；顺带在后台发起一次代码变化检测（有节流） */
function repoFields(repo: RepoContext, autoReindex: boolean) {
  repo.changes.maybeCheck(autoReindex);
  const { ws, indexJobs } = repo;
  // 当前快照已被清理时这里会发起重建，下面的 latest 反映正在重建的任务
  const snap = indexJobs.current();
  const { latest, lastDone } = indexJobs.summary();
  return {
    repo: ws.repo,
    repoGen: repo.gen,
    llmConfigured: ws.config.llm !== undefined,
    llm: ws.config.llm ? { provider: ws.config.llm.provider, model: ws.config.llm.model } : null,
    sendSource: ws.config.overview.sendSource,
    index: { job: jobView(latest), lastDoneAt: lastDone?.finishedAt ?? null },
    snapshot: snapshotView(snap),
    reviews: ws.store.listReviews().map(({ report: _r, ...rest }) => rest),
    overview: overviewSummary(repo, snap),
    changes: repo.changes.view(autoReindex),
  };
}

/** 没有仓库时：LLM 按用户设置和环境变量，源码发送只看环境变量；仓库相关的字段为 null 或空 */
async function noRepoFields(app: AppContext, settings: UserSettings, autoReindex: boolean) {
  const llm = (await loadLlmSources(undefined, { env: app.env, userSettings: settings })).llm;
  return {
    repo: null, repoGen: null,
    llmConfigured: llm !== undefined,
    llm: llm ? { provider: llm.provider, model: llm.model } : null,
    sendSource: !envTurnsOff(app.env, LIMIT_ENV.sendSource),
    index: { job: null, lastDoneAt: null }, snapshot: null, reviews: [], overview: null,
    changes: { checkedAt: null, codeChanged: false, autoReindex, autoReindexFailed: false },
  };
}

/** 上次读到的用户设置和当时文件的状态（路径、mtime、大小） */
let settingsCache: { stamp: string; settings: UserSettings } | undefined;

async function fileStamp(file: string): Promise<string> {
  const st = await stat(file).catch(() => undefined);
  return st ? `${file}:${st.mtimeMs}:${st.size}` : `${file}:none`;
}

/** 每个 server 上次看到的设置文件状态 */
const seenStamp = new WeakMap<AppContext, string>();

/**
 * 设置文件在本 server 上次看到之后变了（可能是另一个 serve 进程保存的）时，重新读当前仓库的配置，
 * status 和问答用上新的模型服务设置。第一次只记下状态：仓库配置刚在打开仓库时读过。
 */
async function refreshIfChanged(app: AppContext, stamp: string): Promise<void> {
  const seen = seenStamp.get(app);
  seenStamp.set(app, stamp);
  if (seen === undefined || seen === stamp) return;
  log.info('user_settings_changed_on_disk', {});
  await refreshRepoConfig(app);
}

/**
 * status 每次轮询都要用户设置：文件没变时用上次的结果，不重复读，也不重复记损坏、权限问题的日志。
 * 读出错时按空设置，status 照常返回。
 */
async function settingsOrEmpty(app: AppContext): Promise<UserSettings> {
  const file = userSettingsPath();
  const stamp = await fileStamp(file);
  await refreshIfChanged(app, stamp);
  if (settingsCache?.stamp === stamp) return settingsCache.settings;
  let settings: UserSettings;
  try {
    settings = await readUserSettings({ path: file });
  } catch (err) {
    log.warn('user_settings_read_failed', { error: (err as Error).message });
    settings = { recentRepos: [] };
  }
  settingsCache = { stamp, settings };
  return settings;
}

/** 仓库、Node 版本、LLM 配置和源码发送开关、索引进度和当前快照、最近的审查和当前概览（不含报告正文）、代码变化 */
async function status(ctx: RequestContext): Promise<void> {
  const { app } = ctx;
  const settings = await settingsOrEmpty(app);
  const autoReindex = settings.autoReindex ?? false;
  // 本接口不计入仓库的 inflight，等待之后取当前仓库，之后同步读它的 Store，不会读到已关闭的旧仓库
  const repo = app.repo;
  const fields = repo ? repoFields(repo, autoReindex) : await noRepoFields(app, settings, autoReindex);
  sendJson(ctx.res, 200, { ...fields, node: process.version, repoLocked: app.locked, dirPickerAvailable: app.dirPicker.tool !== undefined && !app.locked });
}

export const statusRoutes: Route[] = [{ method: 'GET', pattern: '/api/status', handler: status, needsRepo: false }];
