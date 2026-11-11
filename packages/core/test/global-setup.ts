import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

/** 多进程测试的子进程加载 dist，先编译一次保证和源码一致 */
export default function setup(): void {
  const require = createRequire(import.meta.url);
  const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: path.resolve(import.meta.dirname, '..'), stdio: 'inherit' });
}
