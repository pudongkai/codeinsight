import { expect, test, type Page } from '@playwright/test';
import { fakeLlmEnv, firstUserText, startFakeLlm, toolResults, type FakeLlm } from '../../core/test/helpers/fake-llm-server.mjs';
import { shopRepo, startServe, tempDir, type Serve } from './helpers/cli';

/** 问答页：py-shop 仓库，serve 指向假 LLM。用例按顺序执行，后面的用例查看前面留下的会话 */
test.describe.configure({ mode: 'serial' });

const STOP_QUESTION = '这个问题会被停止';
/** 文字分段慢慢发出，页面上能看到逐步出现的回答 */
const SLOW = { deltaChars: 4, chunkChars: 40, delayMs: 80 };

/** search_symbols 结果的第一行：`<id> <kind> <qualifiedName> @ <path>:<start>-<end> | ...` */
function firstSymbol(result: string) {
  const m = /^(\S+) \S+ (\S+) @ (\S+):(\d+)-(\d+)/m.exec(result);
  if (!m) throw new Error(`unexpected tool result: ${result}`);
  return { id: m[1]!, name: m[2]!, path: m[3]!, start: m[4]!, end: m[5]! };
}

/** 第一轮让模型搜索 refund_order，第二轮根据搜索结果回答并引用符号和源码位置；“停止”用例的问题写一点文字后停住 */
function reply(req: Parameters<typeof firstUserText>[0]) {
  if (firstUserText(req).includes(STOP_QUESTION)) return { text: '正在查找相关代码', hang: true };
  const results = toolResults(req);
  if (results.length === 0) return { toolCalls: [{ name: 'search_symbols', input: { query: 'refund_order' } }] };
  const s = firstSymbol(results[0]!);
  const text = `退款入口是 [${s.name}](sym:${s.id})，代码在 [${s.path}:${s.start}-${s.end}](src:${s.path}#L${s.start}-L${s.end})。` +
    '它先读取订单，再调用支付模块退款，最后返回结果。';
  return { text, ...SLOW };
}

let fake: FakeLlm;
let serve: Serve;
let handler: { path: string; start: string };

test.beforeAll(async () => {
  fake = await startFakeLlm({ reply });
  serve = await startServe(shopRepo(), tempDir('ci-e2e-data-'), fakeLlmEnv(fake.url));
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
  await page.getByTestId('chat-input').fill(question);
  await page.getByTestId('chat-send').click();
}

test('asking shows tool progress first, then the answer streams in', async ({ page }) => {
  await openChat(page);
  await expect(page.getByTestId('ask-notice')).toContainText('anthropic');
  await page.getByTestId('ask-notice-accept').click();
  await ask(page, '退款流程怎么走');
  const answer = page.getByTestId('chat-answer');
  await expect(answer.getByTestId('tool-step')).toHaveText('搜索符号 refund_order');
  // 回答还在接收时已经显示了一部分文字
  await expect(answer.getByTestId('answer-text')).toContainText('退款入口是');
  await expect(answer).toHaveAttribute('data-status', 'answering');
  await expect(answer).toHaveAttribute('data-status', 'done');
  await expect(answer.getByTestId('answer-text')).toContainText('最后返回结果。');
  const src = (await answer.getByTestId('src-link').textContent())!;
  const [path, range] = src.split(':');
  handler = { path: path!, start: range!.split('-')[0]! };
  expect(handler.path).toBe('app/orders/api.py');
});

test('clicking a sym: link opens the symbol in the source panel', async ({ page }) => {
  await openChat(page);
  await page.getByTestId('chat-answer').getByTestId('sym-link').click();
  const panel = page.getByTestId('source-panel');
  await expect(panel.locator('h3')).toHaveText(`refund_order  ${handler.path}:${handler.start}`);
  await expect(panel.getByTestId('source-code')).toContainText('def refund_order');
});

test('clicking a src: link opens the source panel at the line', async ({ page }) => {
  await openChat(page);
  await page.getByTestId('chat-answer').getByTestId('src-link').click();
  const panel = page.getByTestId('source-panel');
  await expect(panel.locator('[data-highlight]').first()).toHaveAttribute('data-line', handler.start);
  await expect(panel.locator('h3')).toHaveText(`${handler.path}:${handler.start}`);
});

test('stop ends the answer and marks it stopped', async ({ page }) => {
  await openChat(page);
  // 每个用例是新的浏览器上下文，localStorage 里没有确认记录
  await page.getByTestId('ask-notice-accept').click();
  await page.getByTestId('session-new').click();
  const before = fake.requests.length;
  await ask(page, STOP_QUESTION);
  const answer = page.getByTestId('chat-answer');
  await expect(answer.getByTestId('answer-text')).toHaveText('正在查找相关代码');
  await page.getByTestId('chat-stop').click();
  await expect(answer).toHaveAttribute('data-status', 'cancelled');
  await expect(answer.getByTestId('answer-status')).toHaveText('已停止');
  await expect.poll(() => fake.requests.slice(before).every((r) => r.aborted)).toBe(true);
  await expect(page.getByTestId('chat-send')).toBeVisible();
});

test('after reloading the page the sessions and answers are still there', async ({ page }) => {
  await openChat(page);
  await expect(page.getByTestId('session-item')).toHaveCount(2);
  // 默认选中最近的会话：被停止的那个，保存了已收到的文字
  const answer = page.getByTestId('chat-answer');
  await expect(answer).toHaveAttribute('data-status', 'cancelled');
  await expect(answer.getByTestId('answer-text')).toHaveText('正在查找相关代码');
  await page.getByTestId('session-item').filter({ hasText: '退款流程怎么走' }).click();
  await expect(page.getByTestId('chat-question')).toHaveText('退款流程怎么走');
  await expect(answer).toHaveAttribute('data-status', 'done');
  await expect(answer.getByTestId('sym-link')).toHaveText('refund_order');
  await expect(answer.getByTestId('tool-step')).toHaveText('搜索符号 refund_order');
});
