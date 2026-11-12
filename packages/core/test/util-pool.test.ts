import { describe, expect, it } from 'vitest';
import { defaultModuleName, mapPool, moduleDir, moduleTopDir } from '../src/index.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('mapPool', () => {
  it('keeps the input order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapPool([30, 5, 20, 1, 10, 2], 2, async (ms, i) => {
      running++;
      peak = Math.max(peak, running);
      await tick(ms);
      running--;
      return `${i}:${ms}`;
    });
    expect(out).toEqual(['0:30', '1:5', '2:20', '3:1', '4:10', '5:2']);
    expect(peak).toBe(2);
  });

  it('handles an empty list and a limit larger than the list', async () => {
    expect(await mapPool([], 4, async () => 1)).toEqual([]);
    expect(await mapPool([1, 2], 10, async (x) => x * 2)).toEqual([2, 4]);
  });

  it('rejects with the first error', async () => {
    await expect(mapPool([1, 2, 3], 2, async (x) => {
      if (x === 2) throw new Error('boom');
      return x;
    })).rejects.toThrow('boom');
  });
});

describe('module id helpers', () => {
  it('derives the directory, top-level directory and default name from a module id', () => {
    const cases: [string, string, string, string][] = [
      ['server/modules/billing', 'server/modules/billing', 'server', 'billing'],
      ['server/*', 'server', 'server', 'server/*'],
      ['*', '.', '*', '*'],
      ['app/big#a', 'app/big', 'app', 'big#a'],
      ['#a', '.', '*', '#a'],
      ['scripts', 'scripts', 'scripts', 'scripts'],
    ];
    for (const [id, dir, top, name] of cases) expect([moduleDir(id), moduleTopDir(id), defaultModuleName(id)]).toEqual([dir, top, name]);
  });
});
