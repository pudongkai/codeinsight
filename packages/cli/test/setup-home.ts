import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll } from 'vitest';

/**
 * vitest setupFiles：每个测试文件开始前设一个新的临时 CODEINSIGHT_HOME，
 * 测试不读写本机真实的用户设置，测试文件之间的设置和最近仓库列表也互不影响。
 * 本文件建的目录在测试文件结束时删除；setupFiles 里的 afterAll 排在测试文件自己的
 * afterAll 之后执行（vitest 默认按栈顺序跑 after 钩子），那时子进程已经停掉。
 */
const created: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ci-home-'));
  created.push(dir);
  return dir;
}

/** 起子进程时给它单独的用户目录（子进程环境不继承 process.env 时用） */
export function tempHomeEnv(): { CODEINSIGHT_HOME: string } {
  return { CODEINSIGHT_HOME: tempHome() };
}

// 在 beforeAll 里建：整个文件被跳过时 beforeAll、afterAll 都不执行，不会留下没人删的目录
beforeAll(() => {
  process.env.CODEINSIGHT_HOME = tempHome();
});

afterAll(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
