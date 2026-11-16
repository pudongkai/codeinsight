import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Breadcrumbs, type Crumb } from '../src/browse/Breadcrumbs';

const trail = (n: number): Crumb[] => Array.from({ length: n }, (_, i) => ({ snapshotId: 1, id: `s${i}`, name: `f${i}` }));

describe('Breadcrumbs', () => {
  it('不超过 10 项时全部显示', () => {
    render(<Breadcrumbs trail={trail(10)} onHome={() => {}} onPick={() => {}} />);
    expect(screen.getByTestId('breadcrumbs').textContent).toBe(`首页 › ${trail(10).map((c) => c.name).join(' › ')}`);
  });

  it('超过 10 项时只显示最后 10 项，前面折叠成省略号，点击仍按原下标回退', () => {
    const onPick = vi.fn();
    render(<Breadcrumbs trail={trail(13)} onHome={() => {}} onPick={onPick} />);
    const text = screen.getByTestId('breadcrumbs').textContent;
    expect(text).toBe(`首页 › … › ${trail(13).slice(3).map((c) => c.name).join(' › ')}`);
    expect(screen.getByTitle('f0 › f1 › f2')).toBeTruthy();
    fireEvent.click(screen.getByText('f3'));
    expect(onPick).toHaveBeenCalledWith(3);
  });
});
