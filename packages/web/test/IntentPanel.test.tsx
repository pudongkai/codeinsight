import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReportView } from '../src/report/ReportView';
import { makeReport, ref } from './fixtures';

vi.mock('../src/graph/FlowGraph', () => ({ FlowGraph: () => <div data-testid="flow-stub" /> }));

describe('IntentPanel', () => {
  const report = makeReport({
    intentCheck: [{ verdict: 'unmentioned', summary: 's', modules: ['pkg'], symbols: [ref('old_fn', { startLine: 20 }), ref('new_fn', { startLine: 10 })] }],
  });
  const links = () => screen.getByTestId('intent-panel').querySelectorAll('[data-testid=symbol-link]');

  it('opens a removed function in the base snapshot and an added one in head', () => {
    const showSource = vi.fn();
    render(<ReportView report={report} actions={{ showSource, openGraph: vi.fn() }} />);
    fireEvent.click(links()[0]!);
    expect(showSource).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'id-old_fn', side: 'base', removed: true }));
    fireEvent.click(links()[1]!);
    expect(showSource).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'id-new_fn', side: 'head', removed: false }));
  });

  it('with a JS bridge, does not ask the IDE to open a removed function', () => {
    const openFile = vi.fn();
    window.codeinsightHost = { openFile };
    const showSource = vi.fn();
    render(<ReportView report={report} actions={{ showSource, openGraph: vi.fn() }} />);
    fireEvent.click(links()[0]!);
    expect(openFile).not.toHaveBeenCalled();
    expect(showSource).toHaveBeenCalledWith(expect.objectContaining({ side: 'base' }));
    fireEvent.click(links()[1]!);
    expect(openFile).toHaveBeenCalledWith('pkg/a.py', 10);
  });

  it('explains why the check was skipped, including truncated replies and changes without symbols', () => {
    const skipped = makeReport({
      intentCheck: undefined,
      warnings: [
        { code: 'llm_truncated', level: 'warning', message: 'reply was cut off' },
        { code: 'intent_no_symbols', level: 'info', message: 'no changed symbols' },
        { code: 'config_llm_key_ignored', level: 'warning', message: 'ignored llm.apiKey' },
      ],
    });
    render(<ReportView report={skipped} actions={{ showSource: vi.fn(), openGraph: vi.fn() }} />);
    const panel = screen.getByTestId('intent-panel');
    expect(panel.textContent).toContain('reply was cut off');
    expect(panel.textContent).toContain('no changed symbols');
    expect(panel.textContent).not.toContain('ignored llm.apiKey');
  });
});
