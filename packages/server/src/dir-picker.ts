import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { log } from '@codeinsight/core';

/** 弹窗用的系统命令 */
export type PickerTool = 'osascript' | 'zenity' | 'kdialog' | 'powershell';

export interface PickerCommand {
  command: string;
  args: string[];
}

export interface PickerRunResult {
  /** 进程退出码；被结束或没能启动时为 null */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** 超时被结束 */
  timedOut?: boolean;
  /** 被 signal 中止（客户端断开） */
  aborted?: boolean;
  /** 命令找不到 */
  notFound?: boolean;
  /** 没能启动或异常结束时的错误信息 */
  error?: string;
}

/** 执行弹窗命令（不经 shell）；超时或 signal 中止时结束进程 */
export type RunPicker = (command: string, args: string[], opts: { timeoutMs: number; signal: AbortSignal }) => Promise<PickerRunResult>;

export type PickResult = { status: 'selected'; path: string } | { status: 'cancelled' } | { status: 'timeout' } | { status: 'aborted' };

/** 选择文件夹窗口的依赖和状态，每个 serve 进程一份 */
export interface DirPicker {
  /** 启动时检测到的命令；平台不支持或找不到命令时为 undefined */
  tool: PickerTool | undefined;
  runPicker: RunPicker;
  timeoutMs: number;
  /** 已有一个窗口没关 */
  busy: boolean;
}

export const PICKER_TIMEOUT_MS = 5 * 60_000;
const PROMPT = '选择要分析的仓库';
/** osascript：用户点了取消 */
const MAC_CANCELLED = '-128';
/** osascript：没有控制 System Events 的授权 */
const MAC_NOT_AUTHORIZED = '-1743';
/** osascript：等 System Events 回复超时 */
const MAC_TIMED_OUT = '-1712';
/**
 * AppleScript 等 System Events 回复的上限（默认只等约 2 分钟）。窗口归 System Events，
 * 结束 osascript 关不掉它，所以 osascript 要一直跑到窗口关闭，这个上限只防止进程永远不退出。
 */
export const MAC_APPLE_EVENT_TIMEOUT_S = 600;
/** 比 AppleScript 的上限稍长，正常情况下 osascript 先自己报超时退出 */
const MAC_PROCESS_TIMEOUT_MS = (MAC_APPLE_EVENT_TIMEOUT_S + 30) * 1000;

/** 弹窗失败（非取消）；detail 只写日志 */
export class PickerFailedError extends Error {
  constructor(readonly exitCode: number | null, readonly detail: string) {
    super('the folder picker failed');
  }
}

export class PickerBusyError extends Error {
  constructor() {
    super('a folder picker window is already open');
  }
}

export class PickerUnavailableError extends Error {
  constructor() {
    super('no folder picker is available on this system');
  }
}

function macScript(activate: boolean): string[] {
  const choose = `POSIX path of (choose folder with prompt "${PROMPT}")`;
  // 在 System Events 里弹窗并先激活它，窗口显示在浏览器前面
  return activate
    ? ['tell application "System Events"', 'activate', `with timeout of ${MAC_APPLE_EVENT_TIMEOUT_S} seconds`, `return ${choose}`, 'end timeout', 'end tell']
    : [choose];
}

const WIN_SCRIPT =
  "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }";

/** 各平台的弹窗命令；参数固定，不含用户输入。macOS 的 activate 为 false 时是授权被拒后的退路 */
export function pickerCommand(tool: PickerTool, opts: { activate?: boolean; home?: string } = {}): PickerCommand {
  switch (tool) {
    case 'osascript':
      return { command: 'osascript', args: macScript(opts.activate !== false).flatMap((line) => ['-e', line]) };
    case 'zenity':
      return { command: 'zenity', args: ['--file-selection', '--directory', `--title=${PROMPT}`] };
    case 'kdialog':
      return { command: 'kdialog', args: ['--getexistingdirectory', opts.home ?? homedir(), '--title', PROMPT] };
    case 'powershell':
      return { command: 'powershell', args: ['-NoProfile', '-STA', '-Command', WIN_SCRIPT] };
  }
}

/** PATH 里是否有这个可执行文件；Windows 按 PATHEXT 补扩展名 */
export async function onPath(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      if (await access(path.join(dir, name + ext), constants.X_OK).then(() => true, () => false)) return true;
    }
  }
  return false;
}

export interface DetectOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** 命令是否存在，默认查 PATH */
  exists?: (name: string) => Promise<boolean>;
}

/** 本机能用的弹窗命令：macOS osascript；Linux 有图形界面时 zenity 或 kdialog；Windows powershell */
export async function detectPickerTool(opts: DetectOptions = {}): Promise<PickerTool | undefined> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? ((name: string) => onPath(name, env, platform));
  if (platform === 'darwin') return (await exists('osascript')) ? 'osascript' : undefined;
  if (platform === 'win32') return (await exists('powershell')) ? 'powershell' : undefined;
  if (platform !== 'linux' && platform !== 'freebsd') return undefined;
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return undefined;
  for (const tool of ['zenity', 'kdialog'] as const) if (await exists(tool)) return tool;
  return undefined;
}

/** 默认的 runPicker：execFile，不经 shell */
export const execPicker: RunPicker = (command, args, opts) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: opts.timeoutMs, signal: opts.signal, encoding: 'utf8', maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ exitCode: 0, stdout, stderr });
      const e = err as NodeJS.ErrnoException & { code?: string | number; killed?: boolean };
      if (e.code === 'ENOENT') return resolve({ exitCode: null, stdout, stderr, notFound: true, error: e.message });
      if (opts.signal.aborted) return resolve({ exitCode: null, stdout, stderr, aborted: true });
      if (e.killed) return resolve({ exitCode: null, stdout, stderr, timedOut: true });
      resolve({ exitCode: typeof e.code === 'number' ? e.code : null, stdout, stderr, error: e.message });
    });
  });

/** 去掉末尾的路径分隔符（根目录除外） */
function trimTrailingSep(p: string): string {
  const out = p.replace(/[\\/]+$/, '');
  return out === '' || /^[A-Za-z]:$/.test(out) ? p : out;
}

/** 把一次运行结果转成选择结果；非取消的失败抛 PickerFailedError */
function interpret(tool: PickerTool, r: PickerRunResult): PickResult {
  if (r.notFound) throw new PickerUnavailableError();
  if (r.aborted) return { status: 'aborted' };
  if (r.timedOut) return { status: 'timeout' };
  const out = r.stdout.trim();
  if (r.exitCode === 0 && out !== '') return { status: 'selected', path: trimTrailingSep(out) };
  if (r.exitCode === 0 && tool === 'powershell') return { status: 'cancelled' };
  if (tool === 'osascript' && r.stderr.includes(MAC_CANCELLED)) return { status: 'cancelled' };
  if (tool === 'osascript' && r.stderr.includes(MAC_TIMED_OUT)) return { status: 'timeout' };
  if ((tool === 'zenity' || tool === 'kdialog') && r.exitCode === 1 && out === '') return { status: 'cancelled' };
  throw new PickerFailedError(r.exitCode, (r.error ?? r.stderr).trim().slice(0, 500));
}

/** 窗口还开着、请求已经提前返回时调用，参数在窗口关闭（进程退出）后完成 */
type OnLingering = (closed: Promise<unknown>) => void;

/** 等 run 结束；请求先中止或先超时时提前返回，不结束进程 */
function giveUpEarly(run: Promise<PickerRunResult>, signal: AbortSignal, timeoutMs: number): Promise<PickerRunResult | 'aborted' | 'timeout'> {
  return new Promise((resolve) => {
    const onAbort = () => finish('aborted');
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    function finish(r: PickerRunResult | 'aborted' | 'timeout') {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(r);
    }
    if (signal.aborted) return finish('aborted');
    signal.addEventListener('abort', onAbort);
    void run.then(finish);
  });
}

/**
 * macOS 在 System Events 里弹窗：结束 osascript 关不掉窗口，所以请求中止或超时时只提前返回，
 * 进程继续等到用户关掉窗口，期间仍算“已有窗口”。没有授权时改用不激活的脚本，
 * 那时窗口归 osascript 自己，可以照常随进程结束。
 */
async function runMac(picker: DirPicker, signal: AbortSignal, onLingering: OnLingering): Promise<PickResult> {
  const first = pickerCommand('osascript');
  const run = picker.runPicker(first.command, first.args, { timeoutMs: MAC_PROCESS_TIMEOUT_MS, signal: new AbortController().signal });
  const r = await giveUpEarly(run, signal, picker.timeoutMs);
  if (r === 'aborted' || r === 'timeout') {
    onLingering(run);
    return { status: r };
  }
  if (r.exitCode === 0 || !r.stderr.includes(MAC_NOT_AUTHORIZED)) return interpret('osascript', r);
  log.info('dir_picker_retry', { reason: 'system_events_not_authorized' });
  const fallback = pickerCommand('osascript', { activate: false });
  return interpret('osascript', await picker.runPicker(fallback.command, fallback.args, { timeoutMs: picker.timeoutMs, signal }));
}

/** 弹一次窗口 */
async function runOnce(picker: DirPicker, tool: PickerTool, signal: AbortSignal, onLingering: OnLingering): Promise<PickResult> {
  const cmd = pickerCommand(tool);
  log.info('dir_picker_start', { platform: process.platform, command: cmd.command });
  if (tool === 'osascript') return runMac(picker, signal, onLingering);
  return interpret(tool, await picker.runPicker(cmd.command, cmd.args, { timeoutMs: picker.timeoutMs, signal }));
}

/**
 * 弹出系统选择文件夹窗口并等用户选完。已有窗口没关时抛 PickerBusyError；
 * 找不到命令抛 PickerUnavailableError，非取消的失败抛 PickerFailedError。
 */
export async function pickDirectory(picker: DirPicker, signal: AbortSignal): Promise<PickResult> {
  const tool = picker.tool;
  if (!tool) throw new PickerUnavailableError();
  if (picker.busy) throw new PickerBusyError();
  picker.busy = true;
  let lingering = false;
  const onLingering: OnLingering = (closed) => {
    lingering = true;
    void closed.finally(() => {
      picker.busy = false;
      log.info('dir_picker_window_closed', {});
    });
  };
  const started = Date.now();
  try {
    const result = await runOnce(picker, tool, signal, onLingering);
    log.info('dir_picker_done', { status: result.status, ms: Date.now() - started, ...('path' in result ? { path: result.path } : {}) });
    return result;
  } catch (err) {
    const fields = err instanceof PickerFailedError ? { exitCode: err.exitCode, error: err.detail } : { exitCode: null, error: (err as Error).message };
    log.warn('dir_picker_failed', fields);
    throw err;
  } finally {
    if (!lingering) picker.busy = false;
  }
}
