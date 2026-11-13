import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { detectPickerTool, execPicker, pickerCommand, type PickerRunResult, type PickerTool, type RunPicker } from '../src/dir-picker.js';
import { startHttpServer, type HttpServerOptions, type RunningHttpServer } from '../src/index.js';
import { apiFor, git, openWorkspace, tempDir, waitFor, writeFiles, type Api } from './helpers/env.js';

interface Call { command: string; args: string[]; signal: AbortSignal }

/** 假的弹窗执行：按顺序返回 results，记录每次调用 */
function fakePicker(results: (PickerRunResult | ((signal: AbortSignal) => Promise<PickerRunResult>))[]) {
  const calls: Call[] = [];
  const run: RunPicker = async (command, args, opts) => {
    calls.push({ command, args, signal: opts.signal });
    const next = results.shift() ?? { exitCode: 0, stdout: '' , stderr: '' };
    return typeof next === 'function' ? next(opts.signal) : next;
  };
  return { calls, run };
}

const servers: RunningHttpServer[] = [];

async function start(tool: PickerTool | null, run?: RunPicker, extra: HttpServerOptions = {}): Promise<{ api: Api; server: RunningHttpServer }> {
  const server = await startHttpServer({ indexOnStart: false, env: {}, dirPicker: { tool, runPicker: run }, ...extra });
  servers.push(server);
  return { api: apiFor(server), server };
}

const pick = (api: Api) => api<{ status?: string; path?: string; error?: string; message?: string }>('/api/repo/pick-dir', { method: 'POST' });

/** 反复请求，直到不再返回 picker_busy */
const untilNotBusy = (api: Api) => waitFor(async () => {
  const r = await pick(api);
  return r.body.error === 'picker_busy' ? undefined : r.body;
}, 5000);

afterAll(async () => {
  for (const s of servers) await s.close();
});

describe('picker commands and detection', () => {
  it('builds fixed commands for each platform', () => {
    const mac = pickerCommand('osascript');
    expect(mac.command).toBe('osascript');
    expect(mac.args).toEqual([
      '-e', 'tell application "System Events"', '-e', 'activate', '-e', 'with timeout of 600 seconds',
      '-e', 'return POSIX path of (choose folder with prompt "选择要分析的仓库")', '-e', 'end timeout', '-e', 'end tell',
    ]);
    expect(pickerCommand('osascript', { activate: false }).args).toEqual(['-e', 'POSIX path of (choose folder with prompt "选择要分析的仓库")']);
    expect(pickerCommand('zenity')).toEqual({ command: 'zenity', args: ['--file-selection', '--directory', '--title=选择要分析的仓库'] });
    expect(pickerCommand('kdialog', { home: '/home/me' })).toEqual({ command: 'kdialog', args: ['--getexistingdirectory', '/home/me', '--title', '选择要分析的仓库'] });
    const win = pickerCommand('powershell');
    expect(win.command).toBe('powershell');
    expect(win.args.slice(0, 3)).toEqual(['-NoProfile', '-STA', '-Command']);
    expect(win.args[3]).toContain('System.Windows.Forms.FolderBrowserDialog');
  });

  it.skipIf(process.platform !== 'darwin')('compiles both macOS scripts with osacompile (without running them)', () => {
    const out = path.join(tempDir('ci-picker-osa-'), 'picker.scpt');
    for (const activate of [true, false]) {
      execFileSync('osacompile', ['-o', out, ...pickerCommand('osascript', { activate }).args], { stdio: 'pipe' });
    }
  });

  it('detects the picker per platform', async () => {
    const has = (...names: string[]) => async (n: string) => names.includes(n);
    expect(await detectPickerTool({ platform: 'darwin', exists: has('osascript') })).toBe('osascript');
    expect(await detectPickerTool({ platform: 'darwin', exists: has() })).toBeUndefined();
    expect(await detectPickerTool({ platform: 'win32', exists: has('powershell') })).toBe('powershell');
    expect(await detectPickerTool({ platform: 'linux', env: {}, exists: has('zenity', 'kdialog') })).toBeUndefined();
    expect(await detectPickerTool({ platform: 'linux', env: { DISPLAY: ':0' }, exists: has('zenity', 'kdialog') })).toBe('zenity');
    expect(await detectPickerTool({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, exists: has('kdialog') })).toBe('kdialog');
    expect(await detectPickerTool({ platform: 'linux', env: { DISPLAY: ':0' }, exists: has() })).toBeUndefined();
    expect(await detectPickerTool({ platform: 'aix', exists: has('osascript') })).toBeUndefined();
  });
});

describe('execPicker', () => {
  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  /** 写出自己的 pid 后一直等待的子进程 */
  const sleeper = (pidFile: string) => ['-e', `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`];

  it('kills the process on timeout', async () => {
    const pidFile = path.join(tempDir('ci-picker-'), 'pid');
    const r = await execPicker(process.execPath, sleeper(pidFile), { timeoutMs: 500, signal: new AbortController().signal });
    expect(r.timedOut).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await waitFor(async () => (isAlive(pid) ? undefined : true), 5000);
  });

  it('kills the process when aborted and reports exit codes and missing commands', async () => {
    const pidFile = path.join(tempDir('ci-picker-'), 'pid');
    const ac = new AbortController();
    const running = execPicker(process.execPath, sleeper(pidFile), { timeoutMs: 30_000, signal: ac.signal });
    const pid = await waitFor(async () => {
      try {
        return Number(readFileSync(pidFile, 'utf8')) || undefined;
      } catch {
        return undefined;
      }
    }, 10_000);
    ac.abort();
    expect((await running).aborted).toBe(true);
    await waitFor(async () => (isAlive(pid) ? undefined : true), 5000);
    const signal = new AbortController().signal;
    expect(await execPicker(process.execPath, ['-e', 'process.stdout.write("/x/"); process.exit(3)'], { timeoutMs: 10_000, signal })).toMatchObject({ exitCode: 3, stdout: '/x/' });
    expect((await execPicker('ci-no-such-command-xyz', [], { timeoutMs: 1000, signal })).notFound).toBe(true);
  });
});

describe('POST /api/repo/pick-dir', () => {
  it('returns the selected path without the trailing slash', async () => {
    const f = fakePicker([{ exitCode: 0, stdout: '/Users/me/proj/\n', stderr: '' }]);
    const { api } = await start('osascript', f.run);
    expect((await pick(api)).body).toEqual({ status: 'selected', path: '/Users/me/proj' });
    expect(f.calls[0]).toMatchObject(pickerCommand('osascript'));
    expect((await api<{ dirPickerAvailable: boolean }>('/api/status')).body.dirPickerAvailable).toBe(true);
  });

  it('treats each platform\'s cancel as cancelled and reports timeouts', async () => {
    const cases: [PickerTool, PickerRunResult][] = [
      ['osascript', { exitCode: 1, stdout: '', stderr: 'execution error: User canceled. (-128)' }],
      ['zenity', { exitCode: 1, stdout: '', stderr: '' }],
      ['kdialog', { exitCode: 1, stdout: '', stderr: '' }],
      ['powershell', { exitCode: 0, stdout: '\r\n', stderr: '' }],
    ];
    for (const [tool, result] of cases) {
      const { api } = await start(tool, fakePicker([result]).run);
      expect((await pick(api)).body, tool).toEqual({ status: 'cancelled' });
    }
    const { api } = await start('zenity', fakePicker([{ exitCode: null, stdout: '', stderr: '', timedOut: true }]).run);
    expect((await pick(api)).body).toEqual({ status: 'timeout' });
  });

  it('retries without activating System Events when macOS denies the permission', async () => {
    const f = fakePicker([
      { exitCode: 1, stdout: '', stderr: 'Not authorized to send Apple events to System Events. (-1743)' },
      { exitCode: 0, stdout: '/Users/me/repo/\n', stderr: '' },
    ]);
    const { api } = await start('osascript', f.run);
    expect((await pick(api)).body).toEqual({ status: 'selected', path: '/Users/me/repo' });
    expect(f.calls.map((c) => c.args)).toEqual([pickerCommand('osascript').args, pickerCommand('osascript', { activate: false }).args]);
  });

  it('answers 500 picker_failed without details and 409 when the command is unavailable', async () => {
    const { api } = await start('zenity', fakePicker([{ exitCode: 2, stdout: '', stderr: 'boom /secret/path' }, { exitCode: null, stdout: '', stderr: '', notFound: true }]).run);
    const failed = await pick(api);
    expect(failed.status).toBe(500);
    expect(failed.body.error).toBe('picker_failed');
    expect(JSON.stringify(failed.body)).not.toContain('secret');
    expect((await pick(api)).body.error).toBe('picker_unavailable');
    const none = await start(null);
    expect((await pick(none.api)).body.error).toBe('picker_unavailable');
    expect((await none.api<{ dirPickerAvailable: boolean }>('/api/status')).body.dirPickerAvailable).toBe(false);
  });

  it('allows one window at a time and ends the window when the client disconnects', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let aborted = false;
    const f = fakePicker([
      async () => (await held, { exitCode: 0, stdout: '/a\n', stderr: '' }),
      (signal) => new Promise((resolve) => signal.addEventListener('abort', () => ((aborted = true), resolve({ exitCode: null, stdout: '', stderr: '', aborted: true })))),
      { exitCode: 0, stdout: '/b\n', stderr: '' },
    ]);
    const { api, server } = await start('zenity', f.run);
    const first = pick(api);
    await waitFor(async () => (f.calls.length === 1 ? true : undefined));
    expect((await pick(api)).body.error).toBe('picker_busy');
    release();
    expect((await first).body).toEqual({ status: 'selected', path: '/a' });

    const req = httpRequest({ host: '127.0.0.1', port: server.port, path: '/api/repo/pick-dir', method: 'POST', headers: { Authorization: `Bearer ${server.token}` } });
    req.on('error', () => undefined);
    req.end();
    await waitFor(async () => (f.calls.length === 2 ? true : undefined));
    req.destroy();
    await waitFor(async () => (aborted ? true : undefined), 5000);
    expect((await pick(api)).body).toEqual({ status: 'selected', path: '/b' });
  });

  it('keeps the macOS window process running after a disconnect or timeout and stays busy until the window closes', async () => {
    const closers: (() => void)[] = [];
    const lingering = (signal: AbortSignal) => new Promise<PickerRunResult>((resolve) => {
      expect(signal.aborted).toBe(false);
      closers.push(() => resolve({ exitCode: 1, stdout: '', stderr: 'execution error: User canceled. (-128)' }));
    });
    const f = fakePicker([lingering, { exitCode: 0, stdout: '/b\n', stderr: '' }]);
    const { api, server } = await start('osascript', f.run);

    const req = httpRequest({ host: '127.0.0.1', port: server.port, path: '/api/repo/pick-dir', method: 'POST', headers: { Authorization: `Bearer ${server.token}` } });
    req.on('error', () => undefined);
    req.end();
    await waitFor(async () => (f.calls.length === 1 ? true : undefined));
    req.destroy();
    await new Promise((r) => setTimeout(r, 100));
    expect(f.calls[0]!.signal.aborted).toBe(false);
    expect((await pick(api)).body.error).toBe('picker_busy');
    closers.shift()!();
    expect(await untilNotBusy(api)).toEqual({ status: 'selected', path: '/b' });
  });

  it('reports a macOS timeout as timeout, keeps the window busy until it closes, and maps -1712 to timeout', async () => {
    let close!: () => void;
    const f = fakePicker([
      () => new Promise<PickerRunResult>((resolve) => (close = () => resolve({ exitCode: 1, stdout: '', stderr: '(-128)' }))),
      { exitCode: 1, stdout: '', stderr: 'execution error: AppleEvent timed out. (-1712)' },
    ]);
    const { api } = await start('osascript', f.run, { dirPicker: { tool: 'osascript', runPicker: f.run, timeoutMs: 200 } });
    expect((await pick(api)).body).toEqual({ status: 'timeout' });
    expect((await pick(api)).body.error).toBe('picker_busy');
    close();
    expect(await untilNotBusy(api)).toEqual({ status: 'timeout' });
  });

  it('is unavailable with --lock-repo', async () => {
    const repo = tempDir('ci-picker-repo-');
    git(repo, 'init', '-q', '-b', 'main');
    writeFiles(repo, { 'a.py': 'x = 1\n' });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    const ws = await openWorkspace(repo, tempDir('ci-picker-data-'));
    const f = fakePicker([]);
    const { api } = await start('osascript', f.run, { workspace: ws, lockRepo: true });
    expect((await pick(api)).body.error).toBe('repo_locked');
    expect((await api<{ dirPickerAvailable: boolean }>('/api/status')).body.dirPickerAvailable).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
});
