import { expect, test } from '@playwright/test';
import { fakeLlmEnv, overviewReply, startFakeLlm, type FakeLlm } from '../../core/test/helpers/fake-llm-server.mjs';
import { startServe, type Serve } from './helpers/cli';
import { CLAUVE_DATA_DIR, CLAUVE_REPO, CLAUVE_SOURCE, openClauve, prepareClauveRepo } from './helpers/clauve';

/** clauve 80cf8e1 的概览页（serve 指向假 LLM）：server/modules 下每个业务目录各是一个模块 */
test.skip(!CLAUVE_SOURCE, 'CODEINSIGHT_CLAUVE is not set');
test.describe.configure({ timeout: 20 * 60_000 });

const BUSINESS = ['account', 'auth', 'billing', 'credential', 'lease', 'mail', 'quota', 'release', 'usage_stats'];

let fake: FakeLlm;
let serve: Serve;

test.beforeAll(async () => {
  prepareClauveRepo();
  fake = await startFakeLlm({ reply: overviewReply });
  serve = await startServe(CLAUVE_REPO, CLAUVE_DATA_DIR, fakeLlmEnv(fake.url));
});

test.afterAll(async () => {
  await serve?.stop();
  await fake?.close();
});

test('the overview module list contains the 9 business modules', async ({ page }) => {
  await openClauve(page, serve);
  await page.getByTestId('tab-overview').click();
  await page.getByTestId('overview-generate').click();
  const dialog = page.getByTestId('overview-dialog');
  await expect(dialog.getByTestId('overview-estimate')).toBeVisible({ timeout: 5 * 60_000 });
  await dialog.getByTestId('overview-confirm').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('overview-progress')).toHaveCount(0, { timeout: 10 * 60_000 });
  await expect(page.getByTestId('overview-failed')).toHaveCount(0);
  const items = page.getByTestId('module-list').getByTestId('module-item');
  await expect(items.first()).toBeVisible();
  const ids = await items.evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
  for (const m of BUSINESS) expect(ids).toContain(`server/modules/${m}`);
  await expect(page.locator('[data-testid=module-item][data-id="server/modules/billing"]')).toContainText('模块-server/modules/billing');
});
