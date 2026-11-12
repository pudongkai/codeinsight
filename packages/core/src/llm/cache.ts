import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { log } from '../log.js';
import { writeFileAtomic } from '../util/atomic-file.js';
import type { LlmClient } from './index.js';

/** 各部分用 \0 连接后取 sha256；调用方决定放哪些部分 */
export function llmCacheKey(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

/**
 * LLM 身份 = sha256(provider + 请求地址 + 模型)：同名模型在不同服务上的结果不混用。
 * 只存这个 hash，不存请求地址原文（地址里可能带内网主机名）。
 */
export function llmIdentity(client: Pick<LlmClient, 'provider' | 'model' | 'baseUrl'>): string {
  return llmCacheKey([client.provider, client.baseUrl ?? '', client.model]);
}

/** `<cacheDir>/<key>.json` */
export function llmCacheFile(cacheDir: string, key: string): string {
  return path.join(cacheDir, `${key}.json`);
}

/**
 * 读缓存文件并交给 pick 校验；文件不存在、损坏或 pick 返回 undefined 都算未命中。
 * meta 只写进命中 / 未命中日志（如 provider、model、条目数）。
 */
export async function readLlmCache<T>(cacheDir: string, key: string, pick: (entry: unknown) => T | undefined, meta: Record<string, unknown> = {}): Promise<T | undefined> {
  let value: T | undefined;
  try {
    value = pick(JSON.parse(await readFile(llmCacheFile(cacheDir, key), 'utf8')));
  } catch {
    value = undefined;
  }
  log.info(value === undefined ? 'llm_cache_miss' : 'llm_cache_hit', { ...meta, key: key.slice(0, 16) });
  return value;
}

/** 原子写入缓存；缓存只是加速，写失败（目录只读、磁盘满）只记日志，不影响本次结果 */
export async function writeLlmCache(cacheDir: string, key: string, entry: unknown): Promise<void> {
  const file = llmCacheFile(cacheDir, key);
  try {
    await writeFileAtomic(file, JSON.stringify(entry));
  } catch (err) {
    log.warn('llm_cache_write_failed', { file: path.basename(file), error: (err as Error).message.split('\n')[0] });
  }
}
