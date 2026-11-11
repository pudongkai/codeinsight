export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM：进程存在但属于其他用户
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
