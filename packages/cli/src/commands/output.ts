import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 写到 out 指定的文件（返回绝对路径），没有 out 时写 stdout（返回 undefined） */
export async function writeTextOutput(text: string, out: string | undefined): Promise<string | undefined> {
  if (out === undefined) {
    process.stdout.write(text);
    return undefined;
  }
  const file = path.resolve(out);
  await writeFile(file, text);
  return file;
}
