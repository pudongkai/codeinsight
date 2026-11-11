import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { startServe, type Serve } from './helpers/cli';

/**
 * 方案阶段 6 的 clauve 手工检查的自动版本，只在设置 CODEINSIGHT_CLAUVE（指向 clauve 仓库）时运行。
 * 在 /tmp 下 clone 一份并切到 80cf8e1，serve 只在这份副本上运行，不碰原仓库。截图保存到 /tmp/ci-web-shots/。
 */
const SOURCE = process.env.CODEINSIGHT_CLAUVE?.replace(/^~(?=$|\/)/, homedir());
const REPO = '/tmp/clauve-80cf8e1';
const DATA_DIR = '/tmp/ci-web';
const SHOTS = '/tmp/ci-web-shots';
const COMMIT = '80cf8e1';

test.skip(!SOURCE, 'CODEINSIGHT_CLAUVE is not set');
test.describe.configure({ mode: 'serial', timeout: 20 * 60_000 });

const summary: Record<string, unknown> = {};
let serve: Serve;

function prepareRepo(): void {
  if (!existsSync(REPO)) execFileSync('git', ['clone', '-q', SOURCE!, REPO]);
  const head = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!head.startsWith(COMMIT)) execFileSync('git', ['-C', REPO, 'checkout', '-q', COMMIT]);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
}

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  prepareRepo();
  serve = await startServe(REPO, DATA_DIR);
});

test.afterAll(async () => {
  await serve?.stop();
  writeFileSync(path.join(SHOTS, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
});

async function openApp(page: Page): Promise<void> {
  await page.goto(serve.opened);
  await expect(page.getByTestId('index-time')).toBeVisible({ timeout: 15 * 60_000 });
}

test('entry list shows FastAPI endpoints', async ({ page }) => {
  await openApp(page);
  const entries = page.getByTestId('entry-list');
  await expect(entries.getByRole('heading', { name: 'http · fastapi' })).toBeVisible();
  summary.fastapiEntries = await entries.getByTestId('entry-item').filter({ hasText: /^fastapi / }).count();
  expect(summary.fastapiEntries).toBeGreaterThan(0);
  await shot(page, '01-entries.png');
});

async function insertAuditLogGraph(page: Page): Promise<Locator> {
  await page.getByTestId('search-input').fill('insert_audit_log');
  await page.locator('[data-testid=search-result][data-path="server/modules/lease/repository.py"]').click();
  const graph = page.getByTestId('neighbor-graph');
  await expect(graph.locator('[data-side=center][data-name=insert_audit_log]')).toBeVisible();
  return graph;
}

test('insert_audit_log (lease) has 7 callers on the left, and one caller expands one more level', async ({ page }) => {
  await openApp(page);
  const graph = await insertAuditLogGraph(page);
  const callers = graph.locator('[data-testid=graph-node][data-side=caller][data-level="1"]');
  await expect(callers.first()).toBeVisible();
  summary.insertAuditLogCallers = await callers.count();
  summary.insertAuditLogCallerNames = await callers.evaluateAll((els) => els.map((e) => e.getAttribute('data-qname')));
  await shot(page, '02-insert_audit_log-neighbors.png');
  expect(summary.insertAuditLogCallers).toBe(7);

  const nodes = graph.getByTestId('graph-node');
  for (let i = 0; i < 7; i++) {
    const before = await nodes.count();
    const caller = callers.nth(i);
    const name = await caller.getAttribute('data-qname');
    await caller.getByTestId('expand-node').click();
    await expect(caller.getByTestId('expand-node')).toHaveCount(0);
    await page.waitForTimeout(500);
    if ((await nodes.count()) > before) {
      summary.expanded = { caller: name, nodesBefore: before, nodesAfter: await nodes.count() };
      break;
    }
  }
  await shot(page, '03-expanded.png');
  expect(summary.expanded).toBeTruthy();
});

test('clicking a call in the source panel jumps to the callee neighbor graph', async ({ page }) => {
  await openApp(page);
  const graph = await insertAuditLogGraph(page);
  await graph.locator('[data-testid=graph-node][data-side=caller][data-level="1"]').first().dblclick();
  const panel = page.getByTestId('source-panel');
  const call = panel.getByTestId('source-call').first();
  await expect(call).toBeVisible();
  const target = await call.getAttribute('title');
  await shot(page, '04-source-panel.png');
  await call.click();
  await expect(page.getByTestId('symbol-detail').locator('h3')).toHaveText(target!);
  await expect(graph.locator(`[data-side=center][data-qname="${target}"]`)).toBeVisible();
  summary.sourceJump = target;
  await shot(page, '05-after-jump.png');
});

test('reviewing fc4c752 shows all report panels', async ({ page }) => {
  await openApp(page);
  await page.getByTestId('tab-review').click();
  await page.getByTestId('mode-range').check();
  await page.getByTestId('review-head').fill('fc4c752');
  await page.getByTestId('review-submit').click();
  const report = page.getByTestId('report-view');
  await expect(report).toBeVisible({ timeout: 15 * 60_000 });
  await page.getByTestId('change-row').first().click();
  for (const id of ['report-header', 'warnings-panel', 'change-list', 'impact-panel', 'structure-graph', 'duplicates-panel', 'intent-panel', 'file-list']) {
    await expect(report.getByTestId(id)).toBeVisible();
  }
  const adminAdded = report.getByTestId('change-row').and(page.locator('[data-change=added]')).filter({ hasText: 'server/console/modules/console/admin_api.py' });
  summary.reviewChangeRows = await report.getByTestId('change-row').count();
  summary.adminApiAdded = await adminAdded.count();
  await shot(page, '06-review-fc4c752.png');
  expect(summary.adminApiAdded).toBe(16);
});
