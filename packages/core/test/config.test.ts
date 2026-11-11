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

  it('ignores baseUrl, apiKey and apiKeyEnv from the repository config and warns', async () => {
    const repo = tempDir();
    writeFileSync(
      path.join(repo, 'codeinsight.config.json'),
      JSON.stringify({ llm: { provider: 'openai-compatible', model: 'm', baseUrl: 'https://evil.example', apiKey: 'repo-key', apiKeyEnv: 'AWS_SECRET_ACCESS_KEY' } }),
    );
    const env = { OPENAI_API_KEY: 'user-key', AWS_SECRET_ACCESS_KEY: 'aws-secret' };
    const cfg = await loadConfig(repo, { env });
    expect(cfg.llm).toEqual({ provider: 'openai-compatible', model: 'm', apiKey: 'user-key' });
    expect(cfg.warnings).toEqual([expect.objectContaining({ code: 'config_llm_key_ignored', level: 'warning', message: expect.stringContaining('llm.baseUrl, llm.apiKey, llm.apiKeyEnv') })]);
    expect(JSON.stringify(cfg)).not.toContain('aws-secret');
    expect(JSON.stringify(cfg)).not.toContain('evil.example');

    const fromEnv = await loadConfig(repo, { env: { ...env, CODEINSIGHT_LLM_BASE_URL: 'http://localhost:11434/v1', CODEINSIGHT_LLM_API_KEY: 'env-key' } });
    expect(fromEnv.llm).toEqual({ provider: 'openai-compatible', model: 'm', baseUrl: 'http://localhost:11434/v1', apiKey: 'env-key' });
  });

  it('treats an invalid LLM configuration as not configured instead of failing', async () => {
    const repo = tempDir();
    writeFileSync(path.join(repo, 'codeinsight.config.json'), JSON.stringify({ moduleDepth: 2, llm: { provider: 'gpt' } }));
    const bad = await loadConfig(repo, { env: {} });
    expect(bad.moduleDepth).toBe(2);
    expect(bad.llm).toBeUndefined();
    expect(bad.llmProblem).toContain('unsupported LLM provider: gpt');
    const noModel = await loadConfig(tempDir(), { env: { CODEINSIGHT_LLM_PROVIDER: 'openai-compatible' } });
    expect(noModel.llm).toBeUndefined();
    expect(noModel.llmProblem).toContain('model is missing');
    expect(noModel.warnings).toBeUndefined();
  });
});
