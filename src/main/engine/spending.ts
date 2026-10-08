// Budget and keep-buying arithmetic for a task. No Electron imports, so it is unit tested.
import { formatUsd } from '../../shared/money';
import type { Task, TaskProgress } from '../../shared/types';

export const NO_PROGRESS: TaskProgress = { orders: 0, units: 0, spent: 0 };

/** What an order will cost, read on the store's review page. */
export interface OrderCost {
  subtotal: number | null;
  /** Order total with tax and shipping, when the page shows it. */
  total: number | null;
}

/** Units the remaining budget can pay for at `unitPrice` (before tax; the review page check is exact). */
export function affordableUnits(budget: number | undefined, spent: number, unitPrice: number, wanted: number): number {
  if (budget === undefined) return wanted;
  if (unitPrice <= 0) return wanted;
  return Math.max(0, Math.min(wanted, Math.floor((budget - spent + 0.005) / unitPrice)));
}

/** Why an order of `cost` must not be placed under the task's budget, or null when it fits. */
export function budgetProblem(task: Pick<Task, 'budget'>, progress: TaskProgress, cost: OrderCost): string | null {
  if (task.budget === undefined) return null;
  const amount = cost.total ?? cost.subtotal;
  if (amount === null) return 'Could not read the order total to check this task’s budget';
  if (progress.spent + amount > task.budget + 0.005) {
    return `Budget reached: this order (${formatUsd(amount)}) would bring spending to ${formatUsd(progress.spent + amount)}, over the ${formatUsd(task.budget)} budget`;
  }
  return null;
}

/** True when the task has placed every order it was asked for. */
export function ordersDone(task: Pick<Task, 'maxOrders'>, progress: TaskProgress): boolean {
  return progress.orders >= (task.maxOrders ?? 1);
}

export function describeProgress(task: Pick<Task, 'maxOrders' | 'budget'>, progress: TaskProgress): string {
  const parts = [`${progress.orders} of ${task.maxOrders ?? 1} order(s)`];
  if (task.budget !== undefined) parts.push(`${formatUsd(progress.spent)} of ${formatUsd(task.budget)} spent`);
  return parts.join(', ');
}
