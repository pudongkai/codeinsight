import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setLogSink } from '@codeinsight/core';
import type { ReviewReport } from '@codeinsight/core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { escapeJsonForScript, renderHtmlReport } from '../src/commands/html-report.js';
import { runReviewCommand } from '../src/commands/review.js';

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function makeRepo(): string {
  const repo = tempDir('ci-html-repo-');
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'], { env });
  writeFileSync(path.join(repo, 'a.py'), 'def a():\n    return 1\n');
  execFileSync('git', ['-C', repo, 'add', '-A'], { env });
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { env });
  writeFileSync(path.join(repo, 'a.py'), 'def a():\n    return b()\n\n\ndef b():\n    return 2\n');
  return repo;
}

/** 最小模板：只检查内嵌位置，不依赖 web 构建产物 */
function fakeTemplate(): string {
  const file = path.join(tempDir('ci-html-tpl-'), 'report.html');
  writeFileSync(file, '<!doctype html><html><head><script>/* </body> inside a script */</script></head><body><div id="root"></div></body></html>\n');
  return file;
}

function embedded(html: string): ReviewReport {
  const m = /<script type="application\/json" id="codeinsight-report">([\s\S]*?)<\/script>/.exec(html);
  return JSON.parse(m![1]!) as ReviewReport;
}

beforeAll(() => {
  for (const k of ['CODEINSIGHT_LLM_PROVIDER', 'CODEINSIGHT_LLM_MODEL', 'CODEINSIGHT_LLM_API_KEY', 'CODEINSIGHT_LLM_BASE_URL', 'CODEINSIGHT_DATA_DIR']) delete process.env[k];
});

afterEach(() => vi.restoreAllMocks());

describe('HTML report rendering', () => {
  it('escapes </script>, <!-- and line separators so the JSON cannot end the script block', () => {
    const text = '</script><script>alert(1)</script><!-- & \u2028\u2029';
    const escaped = escapeJsonForScript(JSON.stringify({ text }));
    expect(escaped).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(escaped)).toEqual({ text });
  });

  it('inserts the report before the last </body>', () => {
    const report = { schemaVersion: 1, intent: { source: 'arg', text: '</script>' } } as unknown as ReviewReport;
    const html = renderHtmlReport(report, readFileSync(fakeTemplate(), 'utf8'));
    expect(html.indexOf('codeinsight-report')).toBeGreaterThan(html.indexOf('<div id="root">'));
    expect(embedded(html)).toEqual(report);
  });
});

describe('codeinsight review --format html / --open', () => {
  it('writes the HTML report to --out and opens it with the injected opener', async () => {
    const lines: string[] = [];
    const prev = setLogSink((l) => lines.push(l));
    const prevLevel = process.env.CODEINSIGHT_LOG;
    process.env.CODEINSIGHT_LOG = 'info';
    const out = path.join(tempDir('ci-html-out-'), 'r.html');
    const opened: string[] = [];
    try {
      const code = await runReviewCommand(['--repo', makeRepo(), '--data-dir', tempDir('ci-html-data-'), '--open', '--out', out, '--intent', 'add b </script>'], {
        templatePath: fakeTemplate(), openUrl: (u) => opened.push(u),
      });
      expect(code).toBe(0);
    } finally {
      setLogSink(prev);
      if (prevLevel === undefined) delete process.env.CODEINSIGHT_LOG;
      else process.env.CODEINSIGHT_LOG = prevLevel;
    }
    const report = embedded(readFileSync(out, 'utf8'));
    expect(report.intent?.text).toBe('add b </script>');
    expect(report.modules.flatMap((m) => m.symbols.map((s) => `${s.change}:${s.name}`)).sort()).toEqual(['added:b', 'modified:a']);
    expect(opened.map((u) => fileURLToPath(u))).toEqual([out]);
    expect(lines.some((l) => l.includes('review_report_written') && l.includes('format=html'))).toBe(true);
    expect(lines.some((l) => l.includes('review_report_opened'))).toBe(true);
  });

  it('--open with json or md is an argument error; a missing template fails before reviewing', async () => {
    await expect(runReviewCommand(['--open', '--format', 'json'])).rejects.toThrow(/--open only works with --format html/);
    await expect(runReviewCommand(['--repo', makeRepo(), '--format', 'html'], { templatePath: '/nonexistent/report.html' })).rejects.toThrow(/template not found/);
  });
});
