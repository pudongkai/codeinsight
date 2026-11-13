import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { fakeLlmEnv, firstUserText, startFakeLlm, toolResults, type FakeLlm } from '../../core/test/helpers/fake-llm-server.mjs';
import { shopRepo, startServe, tempDir, type Serve } from './helpers/cli';

/** 问答里助手提出修改 → 确认卡片 → 看 diff → 写入临时仓库；建 PR 的卡片只看显示和忽略（没有真实 gh）。用例按顺序执行，后面的用例查看前面留下的会话 */
test.describe.configure({ mode: 'serial' });

const APPLY_QUESTION = '给订单接口加一行说明';
const DISMISS_QUESTION = '再加一个说明文件';
const PR_QUESTION = '开一个 PR 修改订单接口';
const NOTE = '# 订单接口说明\n\n下单和退款入口都在 app/orders/api.py。\n';

/** 第一轮调用 propose_file_changes（改一个已有文件、新建一个文件），第二轮看到工具结果后回答 */
function reply(req: Parameters<typeof firstUserText>[0]) {
  if (toolResults(req).length > 0) return { text: '已生成待确认的修改，请在下面的卡片里查看并确认。' };
  if (firstUserText(req).includes(PR_QUESTION)) {
    const files = [{ path: 'app/orders/api.py', edits: [{ old: 'router = APIRouter()\n', new: 'router = APIRouter(prefix="/orders")\n' }] }];
    return { toolCalls: [{ name: 'propose_pull_request', input: { title: '订单接口加前缀', body: '说明', base: 'main', branch: 'codeinsight/orders-prefix', files } }] };
  }
  const files = firstUserText(req).includes(DISMISS_QUESTION)
    ? [{ path: 'docs/ignored.md', create: '不会写入\n' }]
    : [
      { path: 'app/orders/api.py', edits: [{ old: 'router = APIRouter()\n', new: '# 订单相关的 HTTP 接口\nrouter = APIRouter()\n' }] },
      { path: 'docs/orders.md', create: NOTE },
    ];
  return { toolCalls: [{ name: 'propose_file_changes', input: { summary: '补充订单接口说明', files } }] };
}

let fake: FakeLlm;
let serve: Serve;
let repo: string;

test.beforeAll(async () => {
  fake = await startFakeLlm({ reply });
  repo = shopRepo();
  // 建 PR 的修改基于本地的 origin/<base>：用本地 bare 仓库作 origin 并先 fetch 一次
  const origin = path.join(tempDir('ci-e2e-origin-'), 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', repo, origin]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', origin]);
  execFileSync('git', ['-C', repo, 'fetch', '-q', 'origin']);
  serve = await startServe(repo, tempDir('ci-e2e-data-'), fakeLlmEnv(fake.url));
});

test.afterAll(async () => {
  await serve?.stop();
  await fake?.close();
});

async function openChat(page: Page): Promise<void> {
  await page.goto(serve.opened);
  await expect(page.getByTestId('index-time')).toBeVisible({ timeout: 120_000 });
  await page.getByTestId('tab-chat').click();
}

async function ask(page: Page, question: string): Promise<void> {
  await page.getByTestId('ask-notice-accept').click();
  await page.getByTestId('session-new').click();
  await page.getByTestId('chat-input').fill(question);
  await page.getByTestId('chat-send').click();
}

test('a proposed change shows a card with its diff, and "写入" writes the files into the repository', async ({ page }) => {
  await openChat(page);
  await expect(page.getByTestId('write-scope')).toContainText('可写：当前仓库');
  await ask(page, APPLY_QUESTION);
  const answer = page.getByTestId('chat-answer');
  await expect(answer).toHaveAttribute('data-status', 'done');
  await expect(answer.getByTestId('tool-steps').locator('summary')).toHaveText('生成了 1 个待确认修改');
  const card = answer.getByTestId('proposal-card');
  await expect(card).toHaveAttribute('data-status', 'pending');
  await expect(card.locator('.proposal-title')).toHaveText('修改 2 个文件 · 写入 当前仓库');
  await expect(card.getByTestId('proposal-file')).toHaveText([/修改 app\/orders\/api\.py/, /新建 docs\/orders\.md/]);

  await card.getByTestId('proposal-diff-toggle').click();
  const apiDiff = card.locator('[data-testid="diff-file"][data-path="app/orders/api.py"]');
  await expect(apiDiff.locator('.diff-add')).toHaveText(['+# 订单相关的 HTTP 接口']);
  await expect(apiDiff.locator('.diff-hunk')).toHaveCount(1);
  await expect(card.locator('[data-testid="diff-file"][data-path="docs/orders.md"] .diff-add').first()).toHaveText('+# 订单接口说明');
  // 确认之前不写盘
  expect(readFileSync(path.join(repo, 'app/orders/api.py'), 'utf8')).not.toContain('订单相关的 HTTP 接口');

  await card.getByTestId('proposal-apply').click();
  await expect(card).toHaveAttribute('data-status', 'applied');
  await expect(card.getByTestId('proposal-result')).toContainText('已写入');
  expect(readFileSync(path.join(repo, 'app/orders/api.py'), 'utf8')).toContain('# 订单相关的 HTTP 接口\nrouter = APIRouter()\n');
  expect(readFileSync(path.join(repo, 'docs/orders.md'), 'utf8')).toBe(NOTE);
});

test('after reloading, the card keeps its result; "忽略" leaves the files untouched', async ({ page }) => {
  await openChat(page);
  await page.getByTestId('session-item').filter({ hasText: APPLY_QUESTION }).click();
  await expect(page.getByTestId('proposal-card')).toHaveAttribute('data-status', 'applied');

  await ask(page, DISMISS_QUESTION);
  const card = page.getByTestId('proposal-card');
  await expect(card).toHaveAttribute('data-status', 'pending');
  await card.getByTestId('proposal-dismiss').click();
  await expect(card.getByTestId('proposal-result')).toHaveText('已忽略');
  expect(() => readFileSync(path.join(repo, 'docs/ignored.md'))).toThrow();
});

test('a proposed pull request shows its card with the branches and diff, and can be ignored', async ({ page }) => {
  await openChat(page);
  await ask(page, PR_QUESTION);
  const card = page.getByTestId('proposal-card');
  await expect(card).toHaveAttribute('data-kind', 'pull_request');
  await expect(card).toHaveAttribute('data-status', 'pending');
  await expect(card.locator('.proposal-title')).toHaveText('创建 PR：订单接口加前缀 → main，新分支 codeinsight/orders-prefix');
  await expect(card.getByTestId('proposal-apply')).toHaveText('创建 PR');
  await card.getByTestId('proposal-diff-toggle').click();
  await expect(card.locator('.diff-add')).toHaveText(['+router = APIRouter(prefix="/orders")']);
  await card.getByTestId('proposal-dismiss').click();
  await expect(card.getByTestId('proposal-result')).toHaveText('已忽略');
});
