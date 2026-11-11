import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { log } from '../log.js';
import { decodeScipIndex, type ScipIndex } from '../scip/reader.js';
import { runScipPython } from '../scip/runner.js';
import { scipPath } from '../store/data-dir.js';
import { scipToEdges } from './scip-edges.js';
import type { ResolveInput, ResolveResult, Resolver } from './types.js';

export interface ScipPythonResolverOptions {
  /** scip-python 入口脚本，默认用依赖里的版本 */
  bin?: string;
}

/**
 * 快照根目录没有 Pyright 配置时写一个最小的 pyrightconfig.json。否则 Pyright 会向上查找，
 * 数据目录在仓库内时找到用户仓库的 pyproject.toml，把仓库根当项目根，跨文件引用全部丢失。
 * 快照里已有 pyrightconfig.json 或 pyproject.toml（没有 [tool.pyright] 时 Pyright 也以它所在目录为根）时不动。
 * 这个文件不在 git 文件清单里，不会被提取。
 */
export async function ensurePyrightRoot(root: string): Promise<void> {
  if (existsSync(path.join(root, 'pyrightconfig.json')) || existsSync(path.join(root, 'pyproject.toml'))) return;
  await writeFile(path.join(root, 'pyrightconfig.json'), '{}\n');
  log.debug('pyright_root_config_written', { root });
}

/** 读取 index.scip；内容不可用时删掉缓存文件，下次重新生成 */
async function readIndex(file: string, expectDocuments: boolean): Promise<ScipIndex> {
  try {
    const index = decodeScipIndex(await readFile(file));
    if (expectDocuments && index.documents.length === 0) throw new Error('scip-python index contains no documents');
    return index;
  } catch (err) {
    await rm(file, { force: true });
    throw err;
  }
}

/** 用 scip-python 解析 Python 引用；index.scip 按 content_key 缓存在数据目录 */
export class ScipPythonResolver implements Resolver {
  readonly name = 'scip-python';

  constructor(private readonly opts: ScipPythonResolverOptions = {}) {}

  async resolve(input: ResolveInput): Promise<ResolveResult> {
    const output = scipPath(input.layout, input.contentKey);
    if (existsSync(output)) {
      log.info('scip_cache_hit', { contentKey: input.contentKey });
    } else {
      await ensurePyrightRoot(input.root);
      await runScipPython({
        cwd: input.root,
        output,
        environment: input.layout.emptyEnvPath,
        projectVersion: input.contentKey,
        timeoutMs: input.timeoutMs,
        bin: this.opts.bin,
      });
    }
    const index = await readIndex(output, input.files.length > 0);
    const sources = new Map<string, string>();
    for (const f of input.files) sources.set(f.path, await readFile(path.join(input.root, f.path), 'utf8'));
    const result = scipToEdges(index, input.files, sources, input.snapshotId);
    log.info('scip_converted', { documents: index.documents.length, edges: result.edges.length });
    return result;
  }
}
