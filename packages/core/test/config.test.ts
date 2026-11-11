import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dataDirInRepo, loadConfig } from '../src/index.js';
import { tempDir } from './helpers/git-repo.js';

describe('config', () => {
  it('uses defaults', async () => {
    const repo = tempDir();
    const cfg = await loadConfig(repo, { env: {} });
    expect(cfg.dataDir).toBe(path.join(repo, '.codeinsight'));
    expect(cfg.moduleDepth).toBe(3);
    expect(cfg.llm).toBeUndefined();
    expect(dataDirInRepo(cfg)).toBe('.codeinsight');
  });

  it('merges file, env and cli options', async () => {
    const repo = tempDir();
    writeFileSync(
      path.join(repo, 'codeinsight.config.json'),
      JSON.stringify({ moduleDepth: 2, dataDir: 'x', llm: { provider: 'anthropic', model: 'm1' } }),
    );
    const cfg = await loadConfig(repo, { env: { ANTHROPIC_API_KEY: 'k', CODEINSIGHT_LLM_MODEL: 'm2' } });
    expect(cfg.moduleDepth).toBe(2);
    expect(cfg.dataDir).toBe(path.join(repo, 'x'));
    expect(cfg.llm).toEqual({ provider: 'anthropic', model: 'm2', apiKey: 'k', baseUrl: undefined });
    const cfg2 = await loadConfig(repo, { env: {}, dataDir: '/tmp/elsewhere' });
    expect(cfg2.dataDir).toBe('/tmp/elsewhere');
    expect(dataDirInRepo(cfg2)).toBeUndefined();
  });
});
