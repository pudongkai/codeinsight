import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { fixtureRepo, runCli, tempDir } from './helpers/cli';

const OUT = '/tmp/r.html';
/** 意图文本里放一段试图结束内嵌脚本块的内容，报告里应按文本显示且不执行 */
const HOSTILE_INTENT = 'Refactor g </script><script>window.__injected = 1</script> <img src=x onerror="window.__injected = 2">';

test('codeinsight review --format html writes a self-contained report that works offline', async ({ page, context }) => {
  runCli(['review', '--repo', fixtureRepo(), '--data-dir', tempDir('ci-e2e-html-'), '--format', 'html', '--out', OUT, '--intent', HOSTILE_INTENT]);
  const html = readFileSync(OUT, 'utf8');
  expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);

  const requests: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('file:')) requests.push(r.url());
  });
  await context.route(/^(?!file:)/, (route) => route.abort());
  await context.setOffline(true);
  await page.goto(pathToFileURL(OUT).href);

  const rows = page.getByTestId('change-list').getByTestId('change-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.and(page.locator('[data-name=k]'))).toHaveAttribute('data-change', 'added');
  await expect(page.getByTestId('structure-graph').getByTestId('graph-node').first()).toBeVisible();
  await expect(page.getByTestId('report-header')).toContainText(HOSTILE_INTENT);
  expect(await page.evaluate(() => (window as unknown as { __injected?: number }).__injected)).toBeUndefined();

  // 离线报告没有源码接口：点击函数只提示位置
  await rows.and(page.locator('[data-name=g]')).click();
  await page.getByTestId('impact-panel').getByTestId('symbol-link').first().click();
  await expect(page.getByText('离线报告不含源码，位置：pkg/repo.py:9')).toBeVisible();
  expect(requests).toEqual([]);
});
