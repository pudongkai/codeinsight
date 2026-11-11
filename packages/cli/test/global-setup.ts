import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

/** 子进程测试运行 cli 的 dist（依赖 core、server 的 dist），先编译一次保证和源码一致 */
export default function setup(): void {
  const require = createRequire(import.meta.url);
  const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
  for (const pkg of ['core', 'server', 'cli']) {
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: path.resolve(import.meta.dirname, '..', '..', pkg), stdio: 'inherit' });
  }
}
