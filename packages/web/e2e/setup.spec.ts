import { appendFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startFakeLlm, type FakeLlm } from '../../core/test/helpers/fake-llm-server.mjs';
import { fixtureRepo, shopRepo, startServe, startServeIn, tempDir, type Serve } from './helpers/cli';

/** 网页里选择仓库、配置模型服务、多个标签页跟着切换仓库 */

const API_KEY = 'sk-e2e-secret-key-7f3a';

async function waitIndexed(page: Page): Promise<void> {
  await expect(page.getByTestId('index-time')).toBeVisible({ timeout: 120_000 });
}

/** 顶栏下拉里的“打开其他仓库…”，输入路径打开 */
async function openOther(page: Page, repo: string): Promise<void> {
  await page.getByTestId('repo-menu-button').click();
  await page.getByTestId('repo-open-other').click();
  const dialog = page.getByTestId('repo-dialog');
  await dialog.getByTestId('repo-path').fill(repo);
  await dialog.getByTestId('repo-open').click();
  await expect(dialog).toHaveCount(0);
}

test.describe('without --repo outside a git repository', () => {
  let serve: Serve;
  test.beforeAll(async () => {
    serve = await startServeIn(tempDir('ci-e2e-cwd-'));
  });
  test.afterAll(async () => {
    await serve?.stop();
  });

  test('shows the repo page; opening a fixtures repo builds the index and the browse page works', async ({ page }) => {
    await page.goto(serve.opened);
    const repoPage = page.getByTestId('repo-page');
    await expect(repoPage).toBeVisible();
    await expect(page.getByTestId('tab-browse')).toHaveCount(0);
    await expect(page.getByTestId('settings-button')).toBeVisible();
    const repo = fixtureRepo();
    await repoPage.getByTestId('repo-path').fill(repo);
    await repoPage.getByTestId('repo-open').click();
    await waitIndexed(page);
    await expect(page.getByTestId('repo-name')).toContainText(path.basename(repo));
    await expect(page.getByTestId('tab-browse')).toHaveClass('active');
    await expect(page.getByTestId('entry-list')).toBeVisible();
  });
});

test.describe('model service settings', () => {
  let serve: Serve;
  let fake: FakeLlm;
  const home = tempDir('ci-e2e-home-');
  test.beforeAll(async () => {
    fake = await startFakeLlm({ reply: () => ({ text: '这是假模型的回答。' }) });
    serve = await startServe(fixtureRepo(), tempDir('ci-e2e-data-'), { CODEINSIGHT_HOME: home });
  });
  test.afterAll(async () => {
    await serve?.stop();
    await fake?.close();
  });

  test('saving a fake LLM in the dialog enables chat; settings.json is 600 and the key never shows on the page', async ({ page }) => {
    await page.goto(serve.opened);
    await waitIndexed(page);
    await page.getByTestId('tab-chat').click();
    const gate = page.getByTestId('chat-no-llm');
    await expect(gate).toContainText('未配置模型服务');
    await gate.getByTestId('open-settings').click();
    const dialog = page.getByTestId('settings-dialog');
    await dialog.getByTestId('settings-provider').selectOption('anthropic');
    await dialog.getByTestId('settings-baseUrl').fill(fake.url);
    await dialog.getByTestId('settings-apiKey').fill(API_KEY);
    await dialog.getByTestId('settings-save').click();
    await expect(dialog.getByTestId('settings-message')).toHaveText('已保存');
    await expect(dialog.getByTestId('settings-apiKey')).toHaveAttribute('placeholder', `已设置（来自用户设置，末 4 位 ${API_KEY.slice(-4)}）留空不修改`);
    await expect(dialog.getByTestId('settings-apiKey')).toHaveValue('');
    expect(await page.content()).not.toContain(API_KEY);
    await dialog.getByTestId('settings-close').click();

    await expect(gate).toHaveCount(0);
    await page.getByTestId('ask-notice-accept').click();
    await page.getByTestId('chat-input').fill('这个仓库做什么');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('answer-text').last()).toContainText('这是假模型的回答。', { timeout: 60_000 });
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(statSync(path.join(home, 'settings.json')).mode & 0o777).toBe(0o600);
    expect(await page.content()).not.toContain(API_KEY);
  });
});

test.describe('switching between two repositories', () => {
  let serve: Serve;
  const repoA = shopRepo();
  const repoB = fixtureRepo();
  test.beforeAll(async () => {
    serve = await startServe(repoA, tempDir('ci-e2e-data-'));
  });
  test.afterAll(async () => {
    await serve?.stop();
  });

  test('a second tab follows the switch within 5 seconds; the overview is still there after switching back', async ({ page, context }) => {
    await page.goto(serve.opened);
    await waitIndexed(page);
    await page.getByTestId('tab-overview').click();
    await page.getByTestId('overview-empty').getByTestId('overview-generate').click();
    await page.getByTestId('overview-dialog').getByTestId('overview-confirm').click();
    await expect(page.getByTestId('system-card')).toBeVisible({ timeout: 120_000 });

    const other = await context.newPage();
    await other.goto(serve.url);
    await expect(other.getByTestId('repo-name')).toContainText(path.basename(repoA));

    await openOther(page, repoB);
    await expect(page.getByTestId('repo-name')).toContainText(path.basename(repoB));
    await expect(other.getByTestId('repo-name')).toContainText(path.basename(repoB), { timeout: 6_000 });
    await expect(other.getByTestId('repo-switched')).toContainText('已切换到仓库');
    await waitIndexed(page);

    await page.getByTestId('repo-menu-button').click();
    await page.getByTestId('repo-menu').locator(`[data-testid=recent-repo][data-path$="${path.basename(repoA)}"] button.link`).click();
    await expect(page.getByTestId('repo-name')).toContainText(path.basename(repoA));
    await expect(other.getByTestId('repo-name')).toContainText(path.basename(repoA), { timeout: 6_000 });
    await expect(page.getByTestId('index-reused')).toHaveText('复用已有索引', { timeout: 60_000 });
    await page.getByTestId('tab-overview').click();
    await expect(page.getByTestId('system-card')).toBeVisible();
  });
});

test.describe('code changes after the index was built', () => {
  let serve: Serve;
  const repo = fixtureRepo();
  test.beforeAll(async () => {
    serve = await startServe(repo, tempDir('ci-e2e-data-'));
  });
  test.afterAll(async () => {
    await serve?.stop();
  });

  test('the top bar shows the commit; editing a file shows "代码已变化", and "更新索引" clears it', async ({ page }) => {
    await page.goto(serve.opened);
    await waitIndexed(page);
    // fixtures 仓库的工作区有未提交改动
    await expect(page.getByTestId('index-commit')).toHaveText(/^基于 [0-9a-f]{8}（含未提交改动）$/);
    await expect(page.getByTestId('code-changed')).toHaveCount(0);
    appendFileSync(path.join(repo, 'pkg', 'repo.py'), '\n\ndef added_later():\n    return 2\n');
    const changed = page.getByTestId('code-changed');
    await expect(changed).toContainText('代码已变化，索引不是最新的', { timeout: 60_000 });
    await changed.getByTestId('update-index').click();
    await expect(changed).toHaveCount(0, { timeout: 60_000 });
    // 建索引结束后再等一轮状态轮询，提示不再出现
    await expect(page.getByTestId('index-progress')).toHaveCount(0, { timeout: 60_000 });
    await page.waitForTimeout(6_000);
    await expect(changed).toHaveCount(0);
  });
});
