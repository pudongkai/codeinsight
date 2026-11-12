import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { expect, type Page } from '@playwright/test';
import type { Serve } from './cli';

/**
 * clauve 用例的公共部分，只在设置 CODEINSIGHT_CLAUVE（指向 clauve 仓库）时运行。
 * 在 /tmp 下 clone 一份并切到 80cf8e1，serve 只在这份副本上运行，不碰原仓库；各 spec 共用同一个数据目录（索引只建一次）。
 */
export const CLAUVE_SOURCE = process.env.CODEINSIGHT_CLAUVE?.replace(/^~(?=$|\/)/, homedir());
export const CLAUVE_REPO = '/tmp/clauve-80cf8e1';
export const CLAUVE_DATA_DIR = '/tmp/ci-web';
const COMMIT = '80cf8e1';

export function prepareClauveRepo(): void {
  if (!existsSync(CLAUVE_REPO)) execFileSync('git', ['clone', '-q', CLAUVE_SOURCE!, CLAUVE_REPO]);
  const head = execFileSync('git', ['-C', CLAUVE_REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!head.startsWith(COMMIT)) execFileSync('git', ['-C', CLAUVE_REPO, 'checkout', '-q', COMMIT]);
}

/** 打开页面并等索引建好（首次建 clauve 的索引要几分钟） */
export async function openClauve(page: Page, serve: Serve): Promise<void> {
  await page.goto(serve.opened);
  await expect(page.getByTestId('index-time')).toBeVisible({ timeout: 15 * 60_000 });
}
