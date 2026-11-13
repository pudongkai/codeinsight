import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import type { SettingsResponse, StatusResponse } from '../src/api/types';
import { App } from '../src/app/App';
import { IDLE_POLL_MS } from '../src/app/useStatus';
import { makeStatus } from './fixtures';

const SETTINGS = {
  path: '/h/settings.json',
  llm: {
    provider: { value: null, source: 'none' }, baseUrl: { value: null, source: 'none' }, model: { value: null, source: 'none' },
    apiKey: { set: false, source: 'none' }, shadowed: [],
  },
  effective: { configured: false, provider: null, model: null, problem: null },
  autoReindex: false,
} as SettingsResponse;

function mockApis(first: StatusResponse) {
  const status = vi.spyOn(api, 'status').mockResolvedValue(first);
  vi.spyOn(api, 'entries').mockResolvedValue({ snapshotId: 7, entries: [] });
  vi.spyOn(api, 'chatSessions').mockResolvedValue({ sessions: [] });
  vi.spyOn(api, 'repos').mockResolvedValue({ current: null, startupRepo: null, locked: false, recent: [] });
  vi.spyOn(api, 'settings').mockResolvedValue(SETTINGS);
  return status;
}

const repoStatus = (repo: string, repoGen: number, extra: Partial<StatusResponse> = {}) => makeStatus({ repo, repoGen, overview: null, ...extra });

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

describe('App', () => {
  it('without a repository shows the repo page, and the top bar only has the settings entry', async () => {
    mockApis(makeStatus({ repo: null, repoGen: null, snapshot: null, overview: null, index: { job: null, lastDoneAt: null } }));
    render(<App />);
    expect(await screen.findByTestId('repo-page')).toBeTruthy();
    const bar = screen.getByTestId('status-bar');
    expect(within(bar).queryByTestId('reindex')).toBeNull();
    expect(within(bar).queryByTestId('repo-name')).toBeNull();
    expect(within(bar).getByTestId('settings-button')).toBeTruthy();
    expect(screen.queryByTestId('tab-browse')).toBeNull();
  });

  it('when the repoGen changes the repo content is rebuilt from scratch and a notice names the new repo', async () => {
    const status = mockApis(repoStatus('/work/a', 1));
    render(<App />);
    fireEvent.click(await screen.findByTestId('tab-chat'));
    expect(screen.getByTestId('tab-chat').className).toBe('active');
    status.mockResolvedValue(repoStatus('/work/b', 2));
    await act(() => vi.advanceTimersByTimeAsync(IDLE_POLL_MS));
    await waitFor(() => expect(screen.getByTestId('repo-name').textContent).toBe('/work/b'));
    expect(screen.getByTestId('tab-browse').className).toBe('active');
    expect(screen.getByTestId('repo-switched').textContent).toContain('已切换到仓库 /work/b');
  });

  it('a locked repository is shown without the switch menu; settings stay available', async () => {
    mockApis(repoStatus('/work/a', 1, { repoLocked: true }));
    render(<App />);
    expect((await screen.findByTestId('repo-name')).textContent).toBe('/work/a');
    expect(screen.queryByTestId('repo-menu-button')).toBeNull();
    expect(screen.getByTestId('settings-button')).toBeTruthy();
  });

  it('the switch menu lists recent repos and opens the "打开其他仓库" dialog', async () => {
    mockApis(repoStatus('/work/a', 1));
    render(<App />);
    fireEvent.click(await screen.findByTestId('repo-menu-button'));
    expect(await within(screen.getByTestId('repo-menu')).findByTestId('recent-repos')).toBeTruthy();
    fireEvent.click(screen.getByTestId('repo-open-other'));
    expect(within(screen.getByTestId('repo-dialog')).getByTestId('repo-path')).toBeTruthy();
  });

  it('without an LLM the chat page offers "打开设置", which opens the settings dialog', async () => {
    mockApis(repoStatus('/work/a', 1, { llm: null, llmConfigured: false }));
    render(<App />);
    fireEvent.click(await screen.findByTestId('tab-chat'));
    const gate = await screen.findByTestId('chat-no-llm');
    expect(gate.textContent).toContain('未配置模型服务');
    fireEvent.click(within(gate).getByTestId('open-settings'));
    expect(await screen.findByTestId('settings-dialog')).toBeTruthy();
    await screen.findByTestId('settings-provider');
  });
});
