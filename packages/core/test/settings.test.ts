import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os, { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  codeinsightHome, MAX_RECENT_REPOS, readUserSettings, removeRecentRepo, setLogSink, touchRecentRepo, updateUserSettings,
  userSettingsPath, writeFileAtomic,
} from '../src/index.js';
import { tempDir } from './helpers/git-repo.js';

const posix = process.platform !== 'win32';
const modeOf = (p: string) => statSync(p).mode & 0o777;

/** 每个用例单独一个设置文件 */
function settingsFile(): string {
  return path.join(tempDir('ci-settings-'), 'home', 'settings.json');
}

let restoreSink: (() => void) | undefined;
function captureLog(): string[] {
  const lines: string[] = [];
  const prev = setLogSink((l) => lines.push(l));
  restoreSink = () => setLogSink(prev);
  return lines;
}
afterEach(() => {
  restoreSink?.();
  restoreSink = undefined;
});

describe('user settings location', () => {
  it('uses CODEINSIGHT_HOME from the process environment, ~/.codeinsight otherwise', () => {
    expect(codeinsightHome({ CODEINSIGHT_HOME: '/tmp/x' })).toBe(path.resolve('/tmp/x'));
    expect(codeinsightHome({})).toBe(path.join(homedir(), '.codeinsight'));
    expect(userSettingsPath({ CODEINSIGHT_HOME: '/tmp/x' })).toBe(path.join(path.resolve('/tmp/x'), 'settings.json'));
  });

  it('reads from the temporary CODEINSIGHT_HOME set for this test file, not the real home', () => {
    const home = process.env.CODEINSIGHT_HOME!;
    expect(home).toBeTruthy();
    expect(userSettingsPath()).toBe(path.join(path.resolve(home), 'settings.json'));
    expect(userSettingsPath()).not.toBe(path.join(homedir(), '.codeinsight', 'settings.json'));
  });
});

describe('user settings read and write', () => {
  it('treats a missing file as empty settings', async () => {
    expect(await readUserSettings({ path: settingsFile() })).toEqual({ recentRepos: [] });
  });

  it('writes the file with mode 600 in a directory with mode 700', async () => {
    const file = settingsFile();
    const saved = await updateUserSettings((s) => ({ ...s, llm: { provider: 'anthropic', apiKey: 'sk-test' }, autoReindex: true }), { path: file });
    expect(saved).toEqual({ llm: { provider: 'anthropic', apiKey: 'sk-test' }, autoReindex: true, recentRepos: [] });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1, llm: { provider: 'anthropic', apiKey: 'sk-test' }, autoReindex: true });
    expect(await readUserSettings({ path: file })).toEqual(saved);
    if (posix) {
      expect(modeOf(file)).toBe(0o600);
      expect(modeOf(path.dirname(file))).toBe(0o700);
    }
  });

  it.skipIf(!posix)('changes a 644 settings file to 600 when reading it', async () => {
    const file = settingsFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, autoReindex: true }));
    chmodSync(file, 0o644);
    const lines = captureLog();
    expect(await readUserSettings({ path: file })).toEqual({ autoReindex: true, recentRepos: [] });
    expect(modeOf(file)).toBe(0o600);
    expect(lines.some((l) => l.includes('user_settings_permissions'))).toBe(true);
  });

  it('treats a broken file as empty and renames it before the next write', async () => {
    const file = settingsFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"llm": {');
    const lines = captureLog();
    expect(await readUserSettings({ path: file })).toEqual({ recentRepos: [] });
    expect(lines.some((l) => l.includes('user_settings_invalid'))).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('{"llm": {');
    await updateUserSettings((s) => ({ ...s, autoReindex: false }), { path: file });
    const broken = readdirSync(path.dirname(file)).filter((f) => f.startsWith('settings.json.broken-'));
    expect(broken).toHaveLength(1);
    expect(readFileSync(path.join(path.dirname(file), broken[0]!), 'utf8')).toBe('{"llm": {');
    expect(await readUserSettings({ path: file })).toEqual({ autoReindex: false, recentRepos: [] });
  });

  it('does not log the file content when the JSON is broken', async () => {
    const file = settingsFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"llm": {"apiKey":sk-ant-secret123}}');
    const lines = captureLog();
    await readUserSettings({ path: file });
    const invalid = lines.filter((l) => l.includes('user_settings_invalid'));
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toMatch(/invalid JSON \(SyntaxError\)/);
    expect(lines.join('\n')).not.toContain('sk-ant');
    expect(lines.join('\n')).not.toContain('secret123');
  });

  it('keeps writing when another writer already renamed the broken file', async () => {
    const file = settingsFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{broken');
    await Promise.all([
      updateUserSettings((s) => ({ ...s, autoReindex: true }), { path: file }),
      updateUserSettings((s) => ({ ...s, autoReindex: true }), { path: file }),
    ]);
    expect(await readUserSettings({ path: file })).toEqual({ autoReindex: true, recentRepos: [] });
    expect(readdirSync(path.dirname(file)).filter((f) => f.startsWith('settings.json.broken-'))).toHaveLength(1);
  });

  it.skipIf(!posix)('keeps the mode of an existing directory that CODEINSIGHT_HOME points to', async () => {
    const file = settingsFile();
    mkdirSync(path.dirname(file), { recursive: true });
    chmodSync(path.dirname(file), 0o755);
    await updateUserSettings((s) => s, { path: file });
    expect(modeOf(path.dirname(file))).toBe(0o755);
    expect(modeOf(file)).toBe(0o600);
  });

  it.skipIf(!posix)('changes an existing 755 default ~/.codeinsight directory to 700 before writing', async () => {
    const fakeHome = tempDir('ci-settings-fakehome-');
    const dir = path.join(fakeHome, '.codeinsight');
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    const spy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    try {
      const lines = captureLog();
      await updateUserSettings((s) => s, { path: path.join(dir, 'settings.json') });
      expect(modeOf(dir)).toBe(0o700);
      expect(lines.some((l) => l.includes('user_settings_dir_permissions'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('logs the written fields at info level without their values', async () => {
    const file = settingsFile();
    const lines = captureLog();
    await updateUserSettings((s) => ({ ...s, llm: { model: 'm-1', apiKey: 'sk-secret-value' }, autoReindex: true }), { path: file });
    const repo = tempDir('ci-recent-log-');
    await touchRecentRepo(repo, { path: file });
    await removeRecentRepo(repo, { path: file });
    const written = lines.filter((l) => l.includes(' INFO user_settings_written '));
    expect(written[0]).toContain('llm.model,llm.apiKey,autoReindex');
    expect(written[1]).toContain('fields=recentRepos');
    expect(lines.some((l) => l.includes(' INFO recent_repo_touched '))).toBe(true);
    expect(lines.some((l) => l.includes(' INFO recent_repo_removed '))).toBe(true);
    expect(lines.join('\n')).not.toContain('sk-secret-value');
    expect(lines.join('\n')).not.toContain('m-1');
  });

  it.skipIf(!posix)('writes through a symbolic link to its target and keeps the link', async () => {
    const file = settingsFile();
    const target = path.join(tempDir('ci-settings-target-'), 'real.json');
    writeFileSync(target, JSON.stringify({ version: 1, autoReindex: false }), { mode: 0o600 });
    mkdirSync(path.dirname(file), { recursive: true });
    symlinkSync(target, file);
    await updateUserSettings((s) => ({ ...s, autoReindex: true }), { path: file });
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toMatchObject({ autoReindex: true });
    expect(readdirSync(path.dirname(target))).toEqual(['real.json']);
  });

  it('treats an unknown version as broken', async () => {
    const file = settingsFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 2, autoReindex: true }));
    expect(await readUserSettings({ path: file })).toEqual({ recentRepos: [] });
  });

  it('ignores only the invalid items and does not log their values', async () => {
    const file = settingsFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      version: 1,
      llm: { provider: 'gpt', model: 'm1', apiKey: 12345, baseUrl: 'https://api.example.com' },
      autoReindex: 'yes',
      recentRepos: [{ path: '/a', lastOpenedAt: 1 }, { path: 'relative', lastOpenedAt: 2 }, 'x'],
    }));
    const lines = captureLog();
    expect(await readUserSettings({ path: file })).toEqual({
      llm: { model: 'm1', baseUrl: 'https://api.example.com' },
      recentRepos: [{ path: '/a', lastOpenedAt: 1 }],
    });
    const ignoredKeys = lines.filter((l) => l.includes('user_settings_value_ignored')).map((l) => /key=(\S+)/.exec(l)?.[1]);
    expect(ignoredKeys).toEqual(['recentRepos', 'llm.provider', 'llm.apiKey', 'autoReindex']);
    expect(lines.join('\n')).not.toContain('12345');
  });
});

describe('writeFileAtomic mode', () => {
  it.skipIf(!posix)('creates a new file and overwrites an existing one with the given mode', async () => {
    const file = path.join(tempDir('ci-atomic-'), 'f.json');
    await writeFileAtomic(file, 'a', { mode: 0o600 });
    expect(modeOf(file)).toBe(0o600);
    writeFileSync(file, 'b');
    chmodSync(file, 0o644);
    await writeFileAtomic(file, 'c', { mode: 0o600 });
    expect(readFileSync(file, 'utf8')).toBe('c');
    expect(modeOf(file)).toBe(0o600);
    expect(readdirSync(path.dirname(file))).toEqual(['f.json']);
  });
});

describe('recent repositories', () => {
  it('keeps the newest first, merges duplicates by real path and keeps at most 10', async () => {
    const file = settingsFile();
    const repos = Array.from({ length: MAX_RECENT_REPOS + 2 }, () => tempDir('ci-recent-'));
    for (const r of repos) await touchRecentRepo(r, { path: file });
    // 同一仓库换一种写法（带 ..）再打开一次，合并成一项并移到最前
    await touchRecentRepo(path.join(repos[5]!, 'sub', '..'), { path: file });
    const list = (await readUserSettings({ path: file })).recentRepos;
    expect(list).toHaveLength(MAX_RECENT_REPOS);
    expect(list[0]!.path).toBe(realpathSync(repos[5]!));
    expect(list.filter((r) => r.path === realpathSync(repos[5]!))).toHaveLength(1);
    expect(list.map((r) => r.lastOpenedAt)).toEqual([...list.map((r) => r.lastOpenedAt)].sort((a, b) => b - a));
    expect(list.map((r) => r.path)).not.toContain(realpathSync(repos[0]!));
    expect(list.map((r) => r.path)).not.toContain(realpathSync(repos[1]!));
  });

  it('removes an entry, and does nothing for a path not in the list', async () => {
    const file = settingsFile();
    const [a, b] = [tempDir('ci-recent-'), tempDir('ci-recent-')];
    await touchRecentRepo(a, { path: file });
    await touchRecentRepo(b, { path: file });
    await removeRecentRepo(a, { path: file });
    expect((await readUserSettings({ path: file })).recentRepos.map((r) => r.path)).toEqual([realpathSync(b)]);
    const before = statSync(file).mtimeMs;
    await removeRecentRepo('/no/such/repo', { path: file });
    expect(statSync(file).mtimeMs).toBe(before);
  });

  it('writes the recent list into this test file\'s own CODEINSIGHT_HOME', async () => {
    const repo = tempDir('ci-recent-own-');
    await touchRecentRepo(repo);
    expect(existsSync(path.join(process.env.CODEINSIGHT_HOME!, 'settings.json'))).toBe(true);
    // 其他测试文件写的条目（前缀 ci-recent-other-）不会出现在这里
    expect((await readUserSettings()).recentRepos.map((r) => r.path)).toEqual([realpathSync(repo)]);
  });
});
