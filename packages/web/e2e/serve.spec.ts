import { expect, test, type Page } from '@playwright/test';
import { fixtureRepo, startServe, tempDir, type Serve } from './helpers/cli';

let serve: Serve;

test.beforeAll(async () => {
  serve = await startServe(fixtureRepo(), tempDir('ci-e2e-data-'));
});

test.afterAll(async () => {
  await serve?.stop();
});

async function openApp(page: Page): Promise<void> {
  await page.goto(serve.opened);
  await expect(page.getByTestId('index-time')).toBeVisible({ timeout: 120_000 });
}

async function openNeighborGraphOfF(page: Page) {
  await page.getByTestId('search-input').fill('f');
  await page.getByTestId('search-result').getByText('f', { exact: true }).click();
  const graph = page.getByTestId('neighbor-graph');
  await expect(graph.locator('[data-testid=graph-node][data-side=center][data-name=f]')).toBeVisible();
  return graph;
}

test('token only goes into the HttpOnly cookie, never into the page', async ({ page }) => {
  expect(serve.opened).toBe(serve.url);
  await openApp(page);
  expect(new URL(page.url()).search).toBe('');
  expect(await page.evaluate(() => ({ cookie: document.cookie, storage: localStorage.length + sessionStorage.length }))).toEqual({ cookie: '', storage: 0 });
});

test('working tree review shows the change list', async ({ page }) => {
  await openApp(page);
  await page.getByTestId('tab-review').click();
  await page.getByTestId('review-submit').click();
  const rows = page.getByTestId('change-list').getByTestId('change-row');
  await expect(rows).toHaveCount(2, { timeout: 120_000 });
  await expect(rows.and(page.locator('[data-name=k]'))).toHaveAttribute('data-change', 'added');
  await expect(rows.and(page.locator('[data-name=g]'))).toHaveAttribute('data-change', 'modified');
  await expect(page.getByTestId('structure-graph').getByTestId('graph-node').first()).toBeVisible();
  await rows.and(page.locator('[data-name=g]')).click();
  await expect(page.getByTestId('impact-panel')).toContainText('影响面（向上 2 层）');
});

test('neighbor graph shows the callers, expands one more level and opens the source panel without a JS bridge', async ({ page }) => {
  await openApp(page);
  const graph = await openNeighborGraphOfF(page);
  const callers = graph.locator('[data-testid=graph-node][data-side=caller]');
  // 测试代码默认隐藏：g、k、use、Service.helper 里的 inner、pkg.service 模块顶层代码
  await expect(callers).toHaveCount(5);
  for (const name of ['g', 'k', 'use', 'Service.helper.<locals>.inner', 'pkg.service']) {
    await expect(callers.and(page.locator(`[data-qname="${name}"]`))).toHaveCount(1);
  }
  await page.getByTestId('toggle-tests').check();
  await expect(callers).toHaveCount(6);
  await page.getByTestId('toggle-tests').uncheck();

  const before = await graph.getByTestId('graph-node').count();
  await graph.locator('[data-testid=graph-node][data-name=g]').getByTestId('expand-node').click();
  await expect.poll(() => graph.getByTestId('graph-node').count()).toBeGreaterThan(before);
  await expect(graph.locator('[data-testid=graph-node][data-name=register][data-level="2"]')).toBeVisible();

  expect(await page.evaluate(() => typeof window.codeinsightHost)).toBe('undefined');
  await page.getByTestId('symbol-location').click();
  const panel = page.getByTestId('source-panel');
  await expect(panel.getByTestId('source-code')).toContainText('def f(x):');
});

test('clicking a call in the source panel jumps to the callee neighbor graph', async ({ page }) => {
  await openApp(page);
  const graph = await openNeighborGraphOfF(page);
  // 单击设为中心，双击查看源码
  await graph.locator('[data-testid=graph-node][data-name=g]').click();
  await expect(page.getByTestId('symbol-detail').locator('h3')).toHaveText('g');
  await graph.locator('[data-testid=graph-node][data-side=center][data-name=g]').dblclick();
  const panel = page.getByTestId('source-panel');
  await expect(panel.getByTestId('source-code')).toContainText('def g():');
  await expect(panel.getByTestId('source-call')).toHaveCount(2);
  await panel.getByTestId('source-call').first().click();
  await expect(page.getByTestId('symbol-detail').locator('h3')).toHaveText('f');
  await expect(page.getByTestId('breadcrumbs')).toHaveText('入口列表 › f › g › f');
});

test('with a JS bridge, clicking a function calls openFile instead of showing the source panel', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    const calls: [string, number][] = [];
    (window as unknown as { __calls: typeof calls }).__calls = calls;
    window.codeinsightHost = { openFile: (path, line) => calls.push([path, line]) };
  });
  await openNeighborGraphOfF(page);
  await page.getByTestId('symbol-location').click();
  expect(await page.evaluate(() => (window as unknown as { __calls: unknown }).__calls)).toEqual([['pkg/repo.py', 4]]);
  await expect(page.getByTestId('source-panel')).toHaveCount(0);
});
