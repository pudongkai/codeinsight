import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReportView } from '../src/report/ReportView';
import { change, makeReport } from './fixtures';

// React Flow 和 ELK 需要真实布局，结构图在 Playwright 测试里覆盖
vi.mock('../src/graph/FlowGraph', () => ({ FlowGraph: () => <div data-testid="flow-stub" /> }));

describe('ReportView', () => {
  it('lists changes by module with change type, entry tag and caller counts', () => {
    render(<ReportView report={makeReport()} />);
    const rows = screen.getAllByTestId('change-row');
    expect(rows.map((r) => r.getAttribute('data-change'))).toEqual(['added', 'removed']);
    expect(rows[0]!.textContent).toContain('入口 · fastapi POST /orders');
    expect(rows[1]!.textContent).toContain('调用方 正式 2 / 测试 1');
    expect(screen.getByTestId('warnings-panel').textContent).toContain('llm_not_configured');
    expect(screen.getByTestId('intent-panel').textContent).toContain('未做意图检查');
  });

  it('renders names, intent and LLM output as plain text', () => {
    const evil = '<img src=x onerror="alert(1)"></script>';
    const report = makeReport({
      intent: { source: 'commits', text: evil },
      modules: [{ module: 'pkg', symbols: [change(evil, 'added')] }],
      intentCheck: [{ verdict: 'unmentioned', summary: evil, symbols: [], modules: ['pkg'] }],
    });
    const { container } = render(<ReportView report={report} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('report-header').textContent).toContain(evil);
    expect(screen.getByTestId('intent-panel').textContent).toContain(evil);
  });

  it('offline: shows the location; with a JS bridge: calls openFile, except for removed functions', () => {
    render(<ReportView report={makeReport()} />);
    fireEvent.click(screen.getAllByTestId('change-row')[0]!);
    fireEvent.click(screen.getByTestId('impact-panel').querySelector('[data-testid=symbol-link]')!);
    expect(screen.getByText('离线报告不含源码，位置：pkg/a.py:10')).toBeTruthy();

    const openFile = vi.fn();
    window.codeinsightHost = { openFile };
    fireEvent.click(screen.getByTestId('impact-panel').querySelector('[data-testid=symbol-link]')!);
    expect(openFile).toHaveBeenCalledWith('pkg/a.py', 10);

    const showSource = vi.fn();
    const { unmount } = render(<ReportView report={makeReport()} actions={{ showSource, openGraph: vi.fn() }} />);
    fireEvent.click(screen.getAllByTestId('change-row')[3]!);
    fireEvent.click(screen.getAllByTestId('impact-panel')[1]!.querySelector('[data-testid=symbol-link]')!);
    expect(showSource).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-old_fn', side: 'base', removed: true }));
    expect(openFile).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('refuses unknown schema versions', () => {
    render(<ReportView report={{ ...makeReport(), schemaVersion: 2 as 1 }} />);
    expect(screen.getByText(/不受支持，请升级/)).toBeTruthy();
  });
});
