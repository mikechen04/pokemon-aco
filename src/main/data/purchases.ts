// Orders this app placed, per account and item, so per-account store limits are respected
// (Target cancels orders past 2 of one item per guest). Encrypted like the other data files.
import { ITEM_LIMIT_WINDOW_DAYS } from '../../shared/constants';
import type { RetailerId } from '../../shared/types';
import { JsonStore } from '../core/fileStore';
import { paths } from '../core/paths';
import { isRetailerId } from './normalize';

export interface PurchaseRecord {
  accountId: string;
  retailer: RetailerId;
  productId: string;
  quantity: number;
  at: number;
  orderNumber?: string;
}

interface PurchasesFile {
  version: 1;
  purchases: PurchaseRecord[];
}

const KEEP_MS = 120 * 86_400_000;

function normalizeFile(raw: unknown): PurchasesFile {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { purchases?: unknown }).purchases)
    ? (raw as { purchases: unknown[] }).purchases
    : [];
  const purchases: PurchaseRecord[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    if (typeof p.accountId !== 'string' || !isRetailerId(p.retailer) || typeof p.productId !== 'string') continue;
    if (typeof p.quantity !== 'number' || typeof p.at !== 'number') continue;
    purchases.push({
      accountId: p.accountId,
      retailer: p.retailer,
      productId: p.productId,
      quantity: Math.max(0, Math.round(p.quantity)),
      at: p.at,
      ...(typeof p.orderNumber === 'string' ? { orderNumber: p.orderNumber } : {}),
    });
  }
  return { version: 1, purchases };
}

export class PurchaseLedger {
  private readonly store: JsonStore<PurchasesFile>;

  constructor(onError: (message: string) => void) {
    this.store = new JsonStore<PurchasesFile>({
      path: paths.dataFile('purchases.json'),
      defaults: () => ({ version: 1, purchases: [] }),
      encrypt: true,
      normalize: normalizeFile,
      onError,
    });
  }

  /** Units of one item an account bought through this app in the limit window. */
  unitsBought(accountId: string, retailer: RetailerId, productId: string, now = Date.now()): number {
    const since = now - ITEM_LIMIT_WINDOW_DAYS * 86_400_000;
    return this.store
      .get()
      .purchases.filter((p) => p.accountId === accountId && p.retailer === retailer && p.productId === productId && p.at >= since)
      .reduce((sum, p) => sum + p.quantity, 0);
  }

  record(purchase: PurchaseRecord): void {
    const cutoff = Date.now() - KEEP_MS;
    this.store.update((file) => ({ ...file, purchases: [...file.purchases.filter((p) => p.at >= cutoff), purchase] }));
  }

  forgetAccounts(accountIds: string[]): void {
    const set = new Set(accountIds);
    this.store.update((file) => ({ ...file, purchases: file.purchases.filter((p) => !set.has(p.accountId)) }));
  }

  flush(): void {
    this.store.flushSync();
  }
}

/**
 * How many units this attempt may buy: the task's quantity, capped by what the store's
 * per-account limit leaves. `limit` 0 means no limit.
 */
export function remainingUnderLimit(limit: number, alreadyBought: number, wanted: number): number {
  if (limit <= 0) return wanted;
  return Math.max(0, Math.min(wanted, limit - alreadyBought));
}
