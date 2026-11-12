import { expect, test, type Page } from '@playwright/test';
import { fakeLlmEnv, overviewReply, startFakeLlm, type FakeLlm } from '../../core/test/helpers/fake-llm-server.mjs';
import { shopRepo, startServe, tempDir, type Serve } from './helpers/cli';

/** 概览页：py-shop 仓库，serve 指向假 LLM。用例按顺序执行，第一个用例生成概览，后面的查看它 */
test.describe.configure({ mode: 'serial' });

const MODULES = ['*', 'app/*', 'app/big#a', 'app/big#c', 'app/common', 'app/leaf', 'app/orders', 'app/payments', 'app/users'];

let fake: FakeLlm;
let serve: Serve;

test.beforeAll(async () => {
  fake = await startFakeLlm({ reply: overviewReply });
  serve = await startServe(shopRepo(), tempDir('ci-e2e-data-'), fakeLlmEnv(fake.url));
});

test.afterAll(async () => {
  await serve?.stop();
  await fake?.close();
});

async function openApp(page: Page): Promise<void> {
  await page.goto(serve.opened);
  await expect(page.getByTestId('index-time')).toBeVisible({ timeout: 120_000 });
}

test('without an overview the page opens on browse; generating estimates first, then shows progress and the result', async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId('entry-list')).toBeVisible();
  await expect(page.getByTestId('tab-browse')).toHaveClass('active');
  await page.getByTestId('tab-overview').click();
  await page.getByTestId('overview-empty').getByTestId('overview-generate').click();
  const dialog = page.getByTestId('overview-dialog');
  await expect(dialog.getByTestId('overview-estimate')).toContainText(/将发送结构信息（含源码片段）到 anthropic（.+），预计 \d+ 次请求/);
  expect(fake.requests).toHaveLength(0);
  await dialog.getByTestId('overview-confirm').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('system-title')).toHaveText('系统简介', { timeout: 120_000 });
  expect(fake.requests.length).toBeGreaterThan(0);
});

test('with an overview the page opens on it; the module graph has the expected modules and red cycle edges', async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId('tab-overview')).toHaveClass('active');
  const graph = page.getByTestId('module-graph');
  const nodes = graph.getByTestId('graph-node');
  await expect(nodes).toHaveCount(MODULES.length);
  expect((await nodes.evaluateAll((els) => els.map((e) => e.getAttribute('data-module')))).sort()).toEqual([...MODULES].sort());
  for (const [from, to] of [['app/orders', 'app/payments'], ['app/payments', 'app/orders']]) {
    const edge = graph.locator(`[data-testid=graph-edge][data-from="${from}"][data-to="${to}"]`);
    await expect(edge).toHaveAttribute('data-tone', 'cycle');
    expect(await edge.locator('path.react-flow__edge-path').evaluate((el) => getComputedStyle(el).stroke)).toBe('rgb(220, 38, 38)');
  }
  const plain = graph.locator('[data-testid=graph-edge][data-from="app/orders"][data-to="app/common"]');
  await expect(plain).toHaveAttribute('data-tone', 'normal');
});

test('clicking a module shows its responsibility and external dependencies', async ({ page }) => {
  await openApp(page);
  await page.getByTestId('module-graph').locator('[data-testid=graph-node][data-module="app/payments"]').click();
  const detail = page.getByTestId('module-detail');
  await expect(detail).toHaveAttribute('data-id', 'app/payments');
  await expect(detail.getByTestId('module-responsibility')).toHaveText('负责 app/payments');
  await expect(detail.getByTestId('module-external')).toContainText('支付：stripe');
  await expect(detail.getByTestId('module-external')).toContainText('HTTP 客户端：httpx');
  await page.getByTestId('module-list').locator('[data-testid=module-item][data-id="app/common"]').click();
  await expect(detail.getByTestId('module-external')).toContainText('数据库：psycopg_pool');
  await expect(detail.getByTestId('env-var')).toHaveText([/DATABASE_URL/, /STRIPE_KEY/]);
});

test('clicking an endpoint in the feature list opens the handler neighbor graph with callees expanded', async ({ page }) => {
  await openApp(page);
  await page.getByTestId('overview-view-features').click();
  const group = page.locator('[data-testid=feature-group][data-module="app/orders"]');
  await group.getByTestId('feature-entry').filter({ hasText: 'POST /orders/{order_id}/refund' }).click();
  await expect(page.getByTestId('tab-browse')).toHaveClass('active');
  const graph = page.getByTestId('neighbor-graph');
  await expect(graph.locator('[data-testid=graph-node][data-side=center][data-name=refund_order]')).toBeVisible();
  const level1 = graph.locator('[data-testid=graph-node][data-side=callee][data-level="1"][data-name=refund]');
  await expect(level1).toBeVisible();
  await expect(level1.getByTestId('expand-node')).toHaveCount(0);
  await expect(graph.locator('[data-testid=graph-node][data-side=callee][data-level="2"][data-name=load_order]')).toBeVisible();
  await expect(graph.locator('[data-testid=graph-node][data-side=callee][data-level="2"][data-name=refund_payment]')).toBeVisible();
});

test('the boundary issue list has all four kinds, and a sample opens the source at its line', async ({ page }) => {
  await openApp(page);
  await page.getByTestId('overview-view-issues').click();
  const groups = page.getByTestId('issue-group');
  await expect(groups).toHaveCount(4);
  expect(await groups.evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))).toEqual(['cycle', 'layer_violation', 'layer_skip', 'private_access']);
  const sample = page.locator('[data-testid=issue-group][data-kind=private_access]').getByTestId('sample-location').first();
  const [path, line] = (await sample.textContent())!.split(':');
  await sample.click();
  const panel = page.getByTestId('source-panel');
  await expect(panel.locator('[data-highlight]')).toHaveAttribute('data-line', line!);
  await expect(panel.locator('h3')).toHaveText(`${path}:${line}`);
});
