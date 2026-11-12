/**
 * 相对路径格式检查（纯函数，不依赖 Node 模块，web 也能用）：POSIX 风格、不是绝对路径（含 `C:` 盘符）、
 * 没有 `.` / `..` / 空段、没有反斜杠和 NUL。调用方传入的应是已解码的路径。
 */
export function isSafeRelativePath(p: string): boolean {
  if (p === '' || p.includes('\0') || p.includes('\\') || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '..' && seg !== '.' && seg !== '');
}
