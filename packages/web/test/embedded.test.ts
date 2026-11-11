import { describe, expect, it } from 'vitest';
import { readEmbeddedReport } from '../src/report/embedded';
import { makeReport } from './fixtures';

describe('embedded report', () => {
  it('reads the report JSON from the script element and explains when it is missing', () => {
    expect(readEmbeddedReport(document).error).toMatch(/报告数据缺失/);
    const el = document.createElement('script');
    el.type = 'application/json';
    el.id = 'codeinsight-report';
    el.textContent = JSON.stringify(makeReport()).replace(/</g, '\\u003c');
    document.body.appendChild(el);
    expect(readEmbeddedReport(document).report?.repo).toBe('/repo');
    el.remove();
  });
});
