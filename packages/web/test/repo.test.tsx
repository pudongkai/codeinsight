import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api/client';
import type { ReposResponse } from '../src/api/types';
import { RepoPage } from '../src/repo/RepoPage';
import { PICK_TIMEOUT_TEXT } from '../src/repo/usePickDir';

const REPOS: ReposResponse = {
  current: { path: '/work/a', gen: 2, dataDir: '/work/a/.codeinsight' },
  startupRepo: '/work/a',
  locked: false,
  recent: [
    { path: '/work/a', lastOpenedAt: 1_794_000_000_000, exists: true },
    { path: '/work/b', lastOpenedAt: 1_793_000_000_000, exists: true },
    { path: '/work/gone', lastOpenedAt: 1_792_000_000_000, exists: false },
  ],
};

function renderPage(dirPickerAvailable = true, repos: ReposResponse = REPOS) {
  vi.spyOn(api, 'repos').mockResolvedValue(repos);
  const onOpened = vi.fn();
  const { unmount } = render(<RepoPage dirPickerAvailable={dirPickerAvailable} onOpened={onOpened} />);
  return { onOpened, unmount };
}

const pathInput = () => screen.getByTestId<HTMLInputElement>('repo-path');
const busy = (tasks: { kind: string; id: number; cancellable: boolean }[]) => new ApiError(409, 'repo_busy', 'repo_busy: tasks are running', { tasks });

describe('RepoPage', () => {
  it('lists recent repos: the current one is marked, missing paths are greyed out and can be removed', async () => {
    const remove = vi.spyOn(api, 'removeRecentRepo').mockResolvedValue({});
    renderPage();
    const items = await screen.findAllByTestId('recent-repo');
    expect(items.map((i) => i.dataset.path)).toEqual(['/work/a', '/work/b', '/work/gone']);
    expect(within(items[0]!).getByTestId('recent-current').textContent).toBe('当前');
    expect(within(items[1]!).queryByTestId('recent-current')).toBeNull();
    expect(items[2]!.className).toContain('missing');
    expect(within(items[2]!).getByRole('button', { name: '/work/gone' })).toHaveProperty('disabled', true);
    expect(within(items[1]!).queryByTestId('recent-remove')).toBeNull();
    fireEvent.click(within(items[2]!).getByTestId('recent-remove'));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('/work/gone'));
    await waitFor(() => expect(api.repos).toHaveBeenCalledTimes(2));
  });

  it('clicking a recent repo opens it', async () => {
    const open = vi.spyOn(api, 'openRepo').mockResolvedValue({ repo: '/work/b', repoGen: 3, dataDir: '/work/b/.codeinsight', reused: false });
    const { onOpened } = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '/work/b' }));
    await waitFor(() => expect(onOpened).toHaveBeenCalledTimes(1));
    expect(open).toHaveBeenCalledWith('/work/b', false);
  });

  it('shows readable errors when opening fails', async () => {
    renderPage();
    const open = vi.spyOn(api, 'openRepo');
    for (const [err, text] of [
      [new ApiError(400, 'not_git_repo', 'not_git_repo: path is not inside a git repository'), '不是 git 仓库'],
      [new ApiError(409, 'data_dir_shared', 'data_dir_shared: unset CODEINSIGHT_DATA_DIR'), '新仓库会和当前仓库用同一个数据目录：unset CODEINSIGHT_DATA_DIR'],
    ] as const) {
      open.mockRejectedValueOnce(err);
      fireEvent.change(pathInput(), { target: { value: '/tmp/x' } });
      fireEvent.click(screen.getByTestId('repo-open'));
      await waitFor(() => expect(screen.getByTestId('repo-open-error').textContent).toBe(text));
    }
  });

  it('repo_busy lists the tasks; "取消并切换" only when all of them can be cancelled', async () => {
    renderPage();
    const open = vi.spyOn(api, 'openRepo').mockRejectedValueOnce(busy([{ kind: 'index', id: 1, cancellable: true }, { kind: 'review', id: 12, cancellable: false }]));
    fireEvent.change(pathInput(), { target: { value: '/work/b' } });
    fireEvent.click(screen.getByTestId('repo-open'));
    const tasks = await screen.findByTestId('repo-busy-tasks');
    expect(within(tasks).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['正在建索引', '审查 #12 进行中']);
    expect(screen.queryByTestId('repo-cancel-switch')).toBeNull();
    expect(screen.getByTestId('repo-wait-tasks').textContent).toBe('等任务结束后再切换');

    open.mockRejectedValueOnce(busy([{ kind: 'ask', id: 5, cancellable: true }])).mockResolvedValueOnce({ repo: '/work/b', repoGen: 3, dataDir: '', reused: false });
    fireEvent.click(screen.getByTestId('repo-open'));
    fireEvent.click(await screen.findByTestId('repo-cancel-switch'));
    await waitFor(() => expect(open).toHaveBeenLastCalledWith('/work/b', true));
  });

  it('without a directory picker the "选择目录…" button is hidden', async () => {
    renderPage(false);
    await screen.findAllByTestId('recent-repo');
    expect(screen.queryByTestId('repo-pick-dir')).toBeNull();
  });

  it('"选择目录…" waits for the window, fills in the chosen path, and leaves the input alone when cancelled', async () => {
    let finish: (v: Awaited<ReturnType<typeof api.pickDir>>) => void = () => undefined;
    const pick = vi.spyOn(api, 'pickDir').mockImplementation(() => new Promise((r) => { finish = r; }));
    renderPage();
    fireEvent.change(pathInput(), { target: { value: '/typed' } });
    fireEvent.click(screen.getByTestId('repo-pick-dir'));
    expect(screen.getByTestId('repo-pick-dir').textContent).toBe('等待选择…');
    expect(screen.getByTestId('repo-pick-dir')).toHaveProperty('disabled', true);
    finish({ status: 'cancelled' });
    await waitFor(() => expect(screen.getByTestId('repo-pick-dir').textContent).toBe('选择目录…'));
    expect(pathInput().value).toBe('/typed');
    expect(screen.queryByTestId('repo-pick-error')).toBeNull();

    pick.mockResolvedValueOnce({ status: 'selected', path: '/Users/me/project' });
    fireEvent.click(screen.getByTestId('repo-pick-dir'));
    await waitFor(() => expect(pathInput().value).toBe('/Users/me/project'));

    pick.mockRejectedValueOnce(new ApiError(409, 'picker_busy', 'picker_busy'));
    fireEvent.click(screen.getByTestId('repo-pick-dir'));
    expect((await screen.findByTestId('repo-pick-error')).textContent).toBe('已经打开了一个选择窗口，请先在那个窗口里选择或取消');

    pick.mockResolvedValueOnce({ status: 'timeout' });
    fireEvent.click(screen.getByTestId('repo-pick-dir'));
    expect((await screen.findByTestId('repo-pick-error')).textContent).toBe(PICK_TIMEOUT_TEXT);
  });

  it('aborts the pick request when the form is unmounted', async () => {
    let signal: AbortSignal | undefined;
    vi.spyOn(api, 'pickDir').mockImplementation((s) => {
      signal = s;
      return new Promise(() => undefined);
    });
    const { unmount } = renderPage();
    fireEvent.click(screen.getByTestId('repo-pick-dir'));
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});
