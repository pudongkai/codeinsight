import { createRequire } from 'node:module';
import path from 'node:path';
import { Language, Parser } from 'web-tree-sitter';

const parsers = new Map<string, Promise<Parser>>();

/** 从语法包根目录的 `<包名>.wasm` 创建解析器 */
async function createParser(pkg: string): Promise<Parser> {
  await Parser.init();
  const require = createRequire(import.meta.url);
  const wasm = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), `${pkg}.wasm`);
  const parser = new Parser();
  parser.setLanguage(await Language.load(wasm));
  return parser;
}

/** 按语法包缓存解析器（进程内只加载一次），加载失败时下次重新加载 */
function cachedParser(pkg: string): Promise<Parser> {
  let p = parsers.get(pkg);
  if (!p) {
    p = createParser(pkg);
    parsers.set(pkg, p);
    p.catch(() => parsers.delete(pkg));
  }
  return p;
}

/** Python 语法解析器（wasm 版） */
export function getPythonParser(): Promise<Parser> {
  return cachedParser('tree-sitter-python');
}

/** Go 语法解析器（wasm 版） */
export function getGoParser(): Promise<Parser> {
  return cachedParser('tree-sitter-go');
}
