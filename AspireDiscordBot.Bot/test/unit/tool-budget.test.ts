import { describe, expect, it, vi } from 'vitest';
import { ToolBudget } from '../../src/agent/tool-budget.js';

describe('ToolBudget', () => {
  it('executes only the configured number of calls', async () => {
    const execute = vi.fn(async () => 'ok');
    const budget = new ToolBudget(1);

    await expect(budget.invoke('one', execute)).resolves.toBe('ok');
    await expect(budget.invoke('two', execute)).resolves.toContain('budget exhausted');
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
