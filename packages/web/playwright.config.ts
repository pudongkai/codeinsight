import { defineConfig, devices } from '@playwright/test';

/**
 * 端到端测试：用 cli 的构建产物（先跑 pnpm -r build）在临时 fixtures 仓库上启动 serve。
 * clauve.spec.ts 只在设置 CODEINSIGHT_CLAUVE 时运行。
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 }, trace: 'off' },
});
