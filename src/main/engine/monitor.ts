// Background stock monitoring. Tasks watching the same product share one poller, so ten
// tasks on one item still make one request per interval. Pollers back off on errors,
// honor Retry-After, and stop on a challenge instead of retrying around it.
import { describeKeywords, type KeywordQuery } from '../../shared/keywords';
import type { RetailerId, Settings } from '../../shared/types';
import type { MonitorContext, ProductTarget, RetailerModule, SearchHit, StockResult } from '../retailers/types';
import { errorMessage, PauseError, QueueError, RetailerError, sleep, type PauseKind } from './errors';
import type { SessionManager } from './sessions';

export interface MonitorSpec {
  retailer: RetailerId;
  module: RetailerModule;
  mode: 'url' | 'keyword';
  product?: ProductTarget;
  keywords?: KeywordQuery;
  zip: string;
  /** Required when the module checks stock in the account's own session. */
  accountId?: string;
}

export type MonitorEvent =
  | { type: 'stock'; result: StockResult }
  | { type: 'hits'; hits: SearchHit[] }
  | { type: 'queue'; detail: string }
  | { type: 'challenge'; kind: PauseKind; detail: string }
  | { type: 'error'; message: string; consecutive: number };

type Listener = (event: MonitorEvent) => void;

function monitorKey(spec: MonitorSpec): string {
  const scope = spec.module.monitorScope === 'account' ? `acct:${spec.accountId ?? ''}` : 'shared';
  const what = spec.mode === 'url' ? `p:${spec.product?.productId ?? ''}` : `k:${spec.keywords ? describeKeywords(spec.keywords) : ''}`;
  return `${spec.retailer}|${scope}|${what}`;
}

class Poller {
  readonly listeners = new Set<Listener>();
  private readonly controller = new AbortController();
  private consecutiveErrors = 0;

  constructor(
    private readonly spec: MonitorSpec,
    private readonly sessions: SessionManager,
    private readonly getSettings: () => Settings,
    private readonly onIdle: () => void,
  ) {}

  start(delayMs: number): void {
    void this.loop(delayMs);
  }

  stop(): void {
    this.controller.abort();
  }

  private emit(event: MonitorEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // a broken listener must not stop the poller
      }
    }
  }

  private async context(): Promise<MonitorContext> {
    const { spec } = this;
    const handle =
      spec.module.monitorScope === 'account' && spec.accountId
        ? await this.sessions.forAccount(spec.accountId, spec.retailer)
        : await this.sessions.forMonitor(spec.retailer);
    return { handle, http: handle.http, settings: this.getSettings(), signal: this.controller.signal, zip: this.spec.zip };
  }

  private async loop(initialDelayMs: number): Promise<void> {
    const signal = this.controller.signal;
    try {
      if (initialDelayMs > 0) await sleep(initialDelayMs, signal);
      while (!signal.aborted && this.listeners.size > 0) {
        const interval = this.getSettings().pollIntervalMs;
        try {
          const ctx = await this.context();
          if (this.spec.mode === 'url' && this.spec.product) {
            this.emit({ type: 'stock', result: await this.spec.module.checkStock(ctx, this.spec.product) });
          } else if (this.spec.keywords) {
            this.emit({ type: 'hits', hits: await this.spec.module.search(ctx, this.spec.keywords) });
          }
          this.consecutiveErrors = 0;
          await sleep(interval, signal);
        } catch (err) {
          if (signal.aborted) break;
          if (err instanceof PauseError) {
            this.emit({ type: 'challenge', kind: err.kind, detail: err.message });
            break;
          }
          if (err instanceof QueueError) {
            this.emit({ type: 'queue', detail: err.detail });
            await sleep(interval, signal);
            continue;
          }
          this.consecutiveErrors++;
          this.emit({ type: 'error', message: errorMessage(err), consecutive: this.consecutiveErrors });
          const retryAfter = err instanceof RetailerError ? err.retryAfterMs : undefined;
          const backoff = Math.min(60_000, interval * 2 ** Math.min(this.consecutiveErrors, 5));
          await sleep(Math.max(retryAfter ?? 0, backoff), signal);
        }
      }
    } catch {
      // aborted while sleeping
    } finally {
      this.onIdle();
    }
  }
}

export class StockMonitor {
  private readonly pollers = new Map<string, Poller>();
  private started = 0;

  constructor(
    private readonly sessions: SessionManager,
    private readonly getSettings: () => Settings,
  ) {}

  /** Starts (or joins) the poller for this product. Returns an unsubscribe function. */
  subscribe(spec: MonitorSpec, listener: Listener): () => void {
    const key = monitorKey(spec);
    let poller = this.pollers.get(key);
    if (!poller) {
      const created = new Poller(spec, this.sessions, this.getSettings, () => {
        if (this.pollers.get(key) === created) this.pollers.delete(key);
      });
      poller = created;
      this.pollers.set(key, created);
      created.listeners.add(listener);
      // Stagger new pollers a little so a "Start all" does not fire every request at once.
      created.start((this.started++ % 10) * 150);
    } else {
      poller.listeners.add(listener);
    }
    const joined = poller;
    return () => {
      joined.listeners.delete(listener);
      if (joined.listeners.size === 0) {
        joined.stop();
        if (this.pollers.get(key) === joined) this.pollers.delete(key);
      }
    };
  }

  get activePollers(): number {
    return this.pollers.size;
  }

  stopAll(): void {
    for (const poller of this.pollers.values()) poller.stop();
    this.pollers.clear();
  }
}
