import { createRequire } from 'node:module';
import path from 'node:path';
import { Language, Parser } from 'web-tree-sitter';

let pythonParser: Promise<Parser> | undefined;

async function createPythonParser(): Promise<Parser> {
  await Parser.init();
  const require = createRequire(import.meta.url);
  const wasm = path.join(path.dirname(require.resolve('tree-sitter-python/package.json')), 'tree-sitter-python.wasm');
  const parser = new Parser();
  parser.setLanguage(await Language.load(wasm));
  return parser;
}

/** Python 语法解析器（wasm 版，进程内只加载一次） */
export function getPythonParser(): Promise<Parser> {
  pythonParser ??= createPythonParser();
  pythonParser.catch(() => (pythonParser = undefined));
  return pythonParser;
}
