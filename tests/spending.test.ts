import { describe, expect, it } from 'vitest';
import { remainingUnderLimit } from '../src/main/data/purchases';
import { affordableUnits, budgetProblem, describeProgress, NO_PROGRESS, ordersDone } from '../src/main/engine/spending';
import { taskInputSchema } from '../src/shared/schemas';

describe('task budget', () => {
  it('caps the quantity to what the remaining budget pays for', () => {
    expect(affordableUnits(undefined, 0, 49.99, 2)).toBe(2);
    expect(affordableUnits(120, 0, 49.99, 2)).toBe(2);
    expect(affordableUnits(120, 54.11, 49.99, 2)).toBe(1);
    expect(affordableUnits(100, 54.11, 49.99, 2)).toBe(0);
    expect(affordableUnits(99.98, 0, 49.99, 2)).toBe(2); // exactly two
  });

  it('checks the real order total (tax included) before an order is placed', () => {
    const task = { budget: 110 };
    expect(budgetProblem({}, NO_PROGRESS, { subtotal: 49.99, total: 54.11 })).toBeNull();
    expect(budgetProblem(task, NO_PROGRESS, { subtotal: 49.99, total: 54.11 })).toBeNull();
    expect(budgetProblem(task, { orders: 1, units: 1, spent: 54.11 }, { subtotal: 49.99, total: 54.11 })).toBeNull();
    expect(budgetProblem(task, { orders: 2, units: 2, spent: 108.22 }, { subtotal: 49.99, total: 54.11 })).toMatch(/Budget reached.*\$162\.33.*\$110\.00/);
    // Falls back to the subtotal, and refuses when neither is readable.
    expect(budgetProblem(task, { orders: 1, units: 1, spent: 60 }, { subtotal: 49.99, total: null })).toBeNull();
    expect(budgetProblem(task, NO_PROGRESS, { subtotal: null, total: null })).toMatch(/Could not read/);
  });

  it('knows when a keep-buying task is done', () => {
    expect(ordersDone({}, { orders: 1, units: 1, spent: 0 })).toBe(true);
    expect(ordersDone({ maxOrders: 3 }, { orders: 2, units: 2, spent: 0 })).toBe(false);
    expect(describeProgress({ maxOrders: 3, budget: 200 }, { orders: 2, units: 4, spent: 108.22 })).toBe('2 of 3 order(s), $108.22 of $200.00 spent');
  });
});

describe('per-account item limits', () => {
  it('leaves what the store limit allows', () => {
    expect(remainingUnderLimit(0, 10, 2)).toBe(2); // no limit
    expect(remainingUnderLimit(2, 0, 2)).toBe(2);
    expect(remainingUnderLimit(2, 1, 2)).toBe(1);
    expect(remainingUnderLimit(2, 2, 1)).toBe(0);
  });
});

describe('task schedule validation', () => {
  const base = { retailer: 'target', mode: 'url', input: '12345678', profileId: 'p', accountId: 'a', quantity: 1, maxPrice: 59.99 } as const;
  it('accepts a schedule, keep-buying and a budget', () => {
    expect(taskInputSchema.safeParse({ ...base, startAt: Date.now() + 3600_000, stopAt: Date.now() + 7200_000, maxOrders: 3, budget: 200 }).success).toBe(true);
  });
  it('rejects a stop before the start and a budget below one item', () => {
    expect(taskInputSchema.safeParse({ ...base, startAt: Date.now() + 7200_000, stopAt: Date.now() + 3600_000 }).success).toBe(false);
    expect(taskInputSchema.safeParse({ ...base, budget: 20 }).success).toBe(false);
    expect(taskInputSchema.safeParse({ ...base, maxOrders: 0 }).success).toBe(false);
  });
});
