// The contract every retailer module implements. To add a store: write a module that
// satisfies RetailerModule, add its id to RETAILER_IDS and metadata to shared/retailers.ts,
// and register it in retailers/registry.ts.
import type { KeywordQuery } from '../../shared/keywords';
import type { LogLevel, Profile, RetailerId, Settings, Task, TaskState } from '../../shared/types';
import type { NotifyKind } from '../core/notifier';
import type { AccountRecord } from '../data/accounts';
import type { StoredCard } from '../data/cards';
import type { BrowserPage } from '../engine/browser';
import type { HttpClient } from '../engine/http';
import type { SessionHandle } from '../engine/sessions';

export interface ProductTarget {
  productId: string;
  url: string;
  title?: string;
}

export interface StockResult {
  inStock: boolean;
  price?: number;
  title?: string;
  imageUrl?: string;
  url?: string;
  /** Raw availability signal for the log, e.g. "ADD_TO_CART" or "OUT_OF_STOCK". */
  detail: string;
  /** Amazon: true when the buy-box offer is sold by Amazon.com itself. */
  soldByRetailer?: boolean;
  /** Module data needed later (offer ids, form tokens). */
  extra?: Record<string, string>;
}

export interface SearchHit {
  productId: string;
  url: string;
  title: string;
  price?: number;
  inStock?: boolean;
  imageUrl?: string;
}

/** What a stock check gets: a session (shared logged-out monitor, or the account's own). */
export interface SessionContext {
  handle: SessionHandle;
  http: HttpClient;
  settings: Settings;
  signal: AbortSignal;
}

export interface MonitorContext extends SessionContext {
  /** Shipping ZIP of the first task watching this product (for fulfillment lookups). */
  zip: string;
}

export interface CartResult {
  quantity: number;
  unitPrice?: number;
  subtotal?: number;
  detail: string;
  /** Where the cart was built; checkout continues the same way when it can. */
  via: 'http' | 'browser';
  extra?: Record<string, string>;
}

export interface CheckoutResult {
  /** False in dry-run mode: everything was verified but the order was not submitted. */
  placed: boolean;
  orderNumber?: string;
  total?: number;
  detail: string;
}

export interface TaskContext extends SessionContext {
  task: Task;
  profile: Profile;
  account: AccountRecord;
  dryRun: boolean;
  log(message: string, level?: LogLevel): void;
  status(state: TaskState, message: string): void;
  notify(kind: NotifyKind, detail: string): void;
  /** This task's hidden browser window in the account's isolated session (opened on first use). */
  page(): Promise<BrowserPage>;
  /**
   * The profile's stored full card, or null. Only for typing into the payment form on the
   * store's own checkout page; never log it or send it anywhere else.
   */
  card(): StoredCard | null;
  /**
   * Call immediately before submitting an order. Throws GoalReachedError when the task's
   * group already has the number of orders the user asked for. Never called in dry runs.
   */
  beforePlaceOrder(): void;
  /** Scratch space a module keeps between steps (prepared ids, cart ids). */
  memo: Map<string, string>;
}

export interface RetailerModule {
  id: RetailerId;
  /** 'account' = stock checks run in the account's own session (e.g. waiting-room cookies). */
  monitorScope: 'shared' | 'account';
  homeUrl: string;
  signInUrl: string;
  checkStock(ctx: MonitorContext, product: ProductTarget): Promise<StockResult>;
  search(ctx: MonitorContext, query: KeywordQuery): Promise<SearchHit[]>;
  /** true = signed in, false = signed out, null = could not tell. */
  checkSignedIn(ctx: SessionContext): Promise<boolean | null>;
  signIn(ctx: TaskContext): Promise<void>;
  /** Runs once when a task starts: warm the session and look up checkout data ahead of the drop. */
  prepare(ctx: TaskContext): Promise<void>;
  addToCart(ctx: TaskContext, product: ProductTarget, stock: StockResult): Promise<CartResult>;
  checkout(ctx: TaskContext, product: ProductTarget, stock: StockResult, cart: CartResult): Promise<CheckoutResult>;
  /** Waits in a waiting room until it lets this session through. Never skips it. */
  waitInQueue?(ctx: TaskContext, product: ProductTarget): Promise<void>;
}
