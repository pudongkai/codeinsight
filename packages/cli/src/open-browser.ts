import { spawn } from 'node:child_process';
import { log } from '@codeinsight/core';

/** 用系统默认浏览器打开 url（http 地址或 file:// 地址）；失败只记日志 */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
  child.on('error', (err) => log.warn('browser_open_failed', { error: err.message }));
  child.unref();
}
