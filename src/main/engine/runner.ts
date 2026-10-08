// One running task: sign in, prepare, wait for stock, cart, verify, check out.
// Challenges pause the task; repeated failures stop it; the kill switch aborts it.
import { matchesKeywords, parseKeywords, type KeywordQuery } from '../../shared/keywords';
import { formatUsd } from '../../shared/money';
import { ITEM_LIMIT_WINDOW_DAYS } from '../../shared/constants';
import { parseProductInput, RETAILERS } from '../../shared/retailers';
import type {
  AccountSessionState,
  LogLevel,
  Profile,
  Settings,
  Task,
  TaskProgress,
  TaskResult,
  TaskRuntime,
  TaskState,
} from '../../shared/types';
import type { NotifyEvent, NotifyKind } from '../core/notifier';
import type { AccountRecord } from '../data/accounts';
import type { StoredCard } from '../data/cards';
import { waitInWaitingRoom } from '../retailers/flows';
import type { MonitorContext, ProductTarget, RetailerModule, SearchHit, StockResult, TaskContext } from '../retailers/types';
import { BrowserPage } from './browser';
import {
  AbortedError,
  DeclinedError,
  errorMessage,
  FatalError,
  GoalReachedError,
  NeedsSignInError,
  OutOfStockError,
  PauseError,
  PriceLimitError,
  QueueError,
  RetailerError,
  sleep,
} from './errors';
import type { MonitorSpec, StockMonitor } from './monitor';
import { affordableUnits, budgetProblem, describeProgress, ordersDone } from './spending';
import type { Semaphore } from './semaphore';
import type { SessionManager } from './sessions';

export interface RunnerDeps {
  task: Task;
  label: () => string;
  module: RetailerModule;
  profile: () => Profile | undefined;
  /** The profile's stored full card, if the user added one. */
  card: () => StoredCard | undefined;
  account: () => AccountRecord | undefined;
  settings: () => Settings;
  sessions: SessionManager;
  monitor: StockMonitor;
  slots: Semaphore;
  update: (patch: Partial<TaskRuntime>) => void;
  log: (level: LogLevel, message: string, state?: TaskState) => void;
  notify: (kind: NotifyKind, detail: string, extra?: Partial<NotifyEvent>) => void;
  accountSession: (state: AccountSessionState, message: string) => void;
  saveResult: (result: TaskResult) => void;
  /** Reserves one order against the group's limit; throws GoalReachedError when it is full. */
  reserveOrder: () => () => void;
  /** True when the task's group already has (or is submitting) all the orders it wants. */
  groupFull: () => boolean;
  /** Orders and spending of this run so far. */
  progress: () => TaskProgress;
  /** Units of an item this account may still buy under the store's per-account limit (null = no limit). */
  itemAllowance: (productId: string) => { remaining: number | null; limit: number; bought: number };
  /** Records a placed order (run progress and the per-account ledger). Returns the new progress. */
  recordOrder: (order: { productId: string; quantity: number; amount: number | null; orderNumber?: string }) => TaskProgress;
}

type Found =
  | { kind: 'stock'; product: ProductTarget; stock: StockResult }
  | { kind: 'queue'; detail: string }
  | { kind: 'resign' };

export class TaskRunner {
  private readonly controller = new AbortController();
  private page: BrowserPage | null;
  private keepPage = false;
  private checkoutFailures = 0;
  private resignRequested = false;
  private interrupt: (() => void) | null = null;
  private notifiedInStock = false;
  private lastLogKey = '';
  private releaseOrder: (() => void) | null = null;
  /** What the order being submitted costs, read on the review page. */
  private pendingCost: number | null = null;
  done: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: RunnerDeps,
    page: BrowserPage | null,
  ) {
    this.page = page;
  }

  start(): void {
    this.done = this.run();
  }

  async stop(): Promise<void> {
    this.controller.abort();
    await this.done;
  }

  /** The window to keep for the user after a pause with handoff; otherwise closes it. */
  releasePage(): BrowserPage | null {
    const page = this.page;
    this.page = null;
    if (!page) return null;
    if (this.keepPage && page.alive) return page;
    page.close();
    return null;
  }

  /** Keep-alive found the account signed out: sign in again before the next checkout. */
  requestSignIn(): void {
    this.resignRequested = true;
    this.interrupt?.();
  }

  /** Frees the hidden window while monitoring (it reopens on the next attempt), unless you are looking at it. */
  private closeIdlePage(): void {
    if (this.page && !this.page.isVisible) {
      this.page.close();
      this.page = null;
    }
  }

  showWindow(): boolean {
    if (!this.page?.alive) return false;
    this.page.show();
    return true;
  }

  private status(state: TaskState, message: string, level: LogLevel = 'info', log = true): void {
    this.deps.update({ state, message });
    if (log) this.deps.log(level, message, state);
  }

  /** Logs only when `key` differs from the last logged key, to keep the log readable. */
  private changed(key: string): boolean {
    if (key === this.lastLogKey) return false;
    this.lastLogKey = key;
    return true;
  }

  private productTarget(): ProductTarget {
    const parsed = parseProductInput(this.deps.task.retailer, this.deps.task.input);
    if (!parsed.ok) throw new FatalError(parsed.error);
    return { productId: parsed.product.productId, url: parsed.product.url, ...(this.deps.task.label ? { title: this.deps.task.label } : {}) };
  }

  private async run(): Promise<void> {
    const signal = this.controller.signal;
    this.deps.update({ running: true, handoff: false, failures: 0 });
    try {
      for (;;) {
        try {
          await this.cycle(signal);
          return;
        } catch (err) {
          if (signal.aborted || err instanceof AbortedError) return;
          if (err instanceof GoalReachedError) {
            // A run that bought something and then hit its budget or limit is a success.
            this.status(this.deps.progress().orders > 0 ? 'checked_out' : 'idle', err.message, 'info');
            return;
          }
          if (err instanceof PauseError) return this.pause(err);
          if (err instanceof DeclinedError || err instanceof FatalError) return this.fail(err.message);
          this.checkoutFailures++;
          const max = this.deps.settings().maxConsecutiveFailures;
          this.deps.update({ failures: this.checkoutFailures });
          if (this.checkoutFailures >= max) {
            return this.fail(`Stopped after ${this.checkoutFailures} failures in a row. Last error: ${errorMessage(err)}`);
          }
          const retryAfter = err instanceof RetailerError ? err.retryAfterMs : undefined;
          const wait = Math.max(retryAfter ?? 0, Math.min(30_000, 2000 * 2 ** (this.checkoutFailures - 1)));
          this.closeIdlePage();
          this.status('monitoring', `${errorMessage(err)}. Retrying in ${Math.ceil(wait / 1000)}s (${this.checkoutFailures}/${max})`, 'warn');
          await sleep(wait, signal);
        }
      }
    } catch (err) {
      if (!(err instanceof AbortedError)) this.fail(errorMessage(err));
    } finally {
      this.deps.update({ running: false });
    }
  }

  /**
   * Units this account may buy of the item: the task's quantity, capped by the store's
   * per-account limit (Target: 2). Ends the task when nothing is left.
   */
  private allowedQuantity(productId: string): number {
    const { task } = this.deps;
    const allowance = this.deps.itemAllowance(productId);
    if (allowance.remaining === null) return task.quantity;
    if (allowance.remaining <= 0) {
      throw new GoalReachedError(
        `${RETAILERS[task.retailer].name} allows ${allowance.limit} of an item per account and this account already bought ${allowance.bought} in the last ${ITEM_LIMIT_WINDOW_DAYS} days (Settings → Safety to change)`,
      );
    }
    return Math.min(task.quantity, allowance.remaining);
  }

  private async cycle(signal: AbortSignal): Promise<void> {
    const { task } = this.deps;
    const progress = this.deps.progress();
    if (ordersDone(task, progress)) throw new GoalReachedError(`Already done: ${describeProgress(task, progress)}`);
    if (task.mode === 'url') this.allowedQuantity(this.productTarget().productId);
    const ctx = await this.context(signal);
    await this.ensureSignedIn(ctx, false);
    this.status('monitoring', 'Preparing checkout details', 'info', false);
    await this.withQueue(ctx, () => this.deps.module.prepare(ctx));
    // Hidden windows are opened again at checkout time; idle tasks should not hold one.
    this.closeIdlePage();
    this.status('monitoring', this.deps.task.mode === 'keyword' ? 'Searching for a matching product' : 'Watching stock');
    for (;;) {
      const found = await this.waitForStock(ctx);
      if (found.kind === 'resign') {
        await this.ensureSignedIn(ctx, true);
        continue;
      }
      if (found.kind === 'queue') {
        const product = this.deps.task.mode === 'url' ? this.productTarget() : undefined;
        await this.enterQueue(ctx, product, found.detail);
        if (!product) continue;
        // The shared monitor's session may still be in line; this account's session is
        // through, so check stock with it before going back to the shared monitor.
        const own = await this.ownSessionStock(ctx, product);
        const decision = own ? this.judgeStock(product, own) : null;
        if (decision && (await this.attempt(ctx, decision.product, decision.stock))) return;
        if (!decision) await sleep(this.deps.settings().pollIntervalMs, ctx.signal);
        continue;
      }
      if (await this.attempt(ctx, found.product, found.stock)) return;
    }
  }

  private async context(signal: AbortSignal): Promise<TaskContext> {
    const { task, sessions } = this.deps;
    const profile = this.deps.profile();
    if (!profile) throw new FatalError('The profile for this task was deleted. Edit the task and pick a profile.');
    const account = this.deps.account();
    if (!account) throw new FatalError('The account for this task was deleted. Edit the task and pick an account.');
    if (account.retailer !== task.retailer) {
      throw new FatalError(`The selected account is for ${RETAILERS[account.retailer].name}, not ${RETAILERS[task.retailer].name}.`);
    }
    if (!/^\d{4}$/.test(profile.cardLast4)) throw new FatalError(`Profile "${profile.name}" is missing the card's last 4 digits.`);
    const handle = await sessions.forAccount(account.id, task.retailer);
    const settings = this.deps.settings();
    return {
      task,
      profile,
      account,
      settings,
      handle,
      http: handle.http,
      signal,
      dryRun: settings.dryRun,
      memo: new Map(),
      log: (message, level = 'info') => this.deps.log(level, message),
      status: (state, message) => this.status(state, message),
      notify: (kind, detail) => this.deps.notify(kind, detail),
      card: () => this.deps.card() ?? null,
      beforePlaceOrder: (cost) => {
        const problem = budgetProblem(task, this.deps.progress(), cost);
        if (problem) {
          if (cost.total === null && cost.subtotal === null) throw new PauseError('needs_review', `${problem}. Nothing was ordered.`, true);
          throw new GoalReachedError(`${problem}. Nothing was ordered.`);
        }
        this.pendingCost = cost.total ?? cost.subtotal;
        if (!this.releaseOrder) this.releaseOrder = this.deps.reserveOrder();
      },
      page: async () => {
        if (!this.page?.alive) {
          this.page = BrowserPage.open(
            handle,
            `${RETAILERS[task.retailer].name} · ${this.deps.label()}`,
            this.deps.settings().showAutomationWindows,
          );
        }
        return this.page;
      },
    };
  }

  /** Runs a step; if a waiting room is in the way, waits in it and runs the step again. */
  private async withQueue<T>(ctx: TaskContext, work: () => Promise<T>, product?: ProductTarget): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await work();
      } catch (err) {
        if (!(err instanceof QueueError) || attempt >= 5) throw err;
        await this.enterQueue(ctx, product, err.detail, err.url);
      }
    }
  }

  private async enterQueue(ctx: TaskContext, product: ProductTarget | undefined, detail: string, url?: string): Promise<void> {
    const { module, task } = this.deps;
    const name = RETAILERS[task.retailer].name;
    this.status('queued', `${name} waiting room ahead (${detail}). Joining the line.`, 'warn');
    if (module.waitInQueue && product) {
      await module.waitInQueue(ctx, product);
    } else {
      const page = await ctx.page();
      await page.goto(url ?? product?.url ?? module.homeUrl, ctx.signal);
      await waitInWaitingRoom(ctx, page, name);
    }
    this.deps.notify('queue', 'Through the waiting room, continuing.');
    this.status('monitoring', 'Through the waiting room', 'success');
  }

  private async ensureSignedIn(ctx: TaskContext, force: boolean): Promise<void> {
    const { module, accountSession } = this.deps;
    const name = RETAILERS[ctx.task.retailer].name;
    this.status('monitoring', 'Checking sign-in', 'info', false);
    let signedIn: boolean | null = null;
    try {
      signedIn = await module.checkSignedIn(ctx);
    } catch (err) {
      if (err instanceof PauseError || err instanceof AbortedError) throw err;
      this.deps.log('warn', `Could not check the ${name} session: ${errorMessage(err)}`);
    }
    if (signedIn === true) {
      accountSession('signed_in', 'Signed in');
      this.resignRequested = false;
      return;
    }
    if (signedIn === null && !force) {
      this.deps.log('info', `Could not confirm the ${name} sign-in up front; checkout will verify it.`);
      return;
    }
    accountSession('checking', 'Signing in');
    this.status('monitoring', `Signing in to ${name}`);
    try {
      await this.withQueue(ctx, () => module.signIn(ctx));
    } catch (err) {
      if (err instanceof PauseError) accountSession('needs_attention', err.message);
      else if (!(err instanceof AbortedError)) accountSession('signed_out', `Sign-in failed: ${errorMessage(err)}`);
      throw err;
    }
    const after = await module.checkSignedIn(ctx).catch(() => null);
    if (after === false) {
      accountSession('signed_out', 'Sign-in did not work');
      throw new PauseError(
        'sign_in_required',
        `Signing in to ${name} did not work. Check the saved password, or use Accounts → Sign in to do it by hand, then press Start.`,
        Boolean(this.page?.alive),
      );
    }
    accountSession('signed_in', 'Signed in');
    this.resignRequested = false;
    this.deps.log('success', `Signed in to ${name}`);
  }

  private monitorContextFor(ctx: TaskContext): MonitorContext {
    return { handle: ctx.handle, http: ctx.http, settings: ctx.settings, signal: ctx.signal, zip: ctx.profile.shipping.zip };
  }

  /** Decide whether a stock result is buyable for this task. Updates the table either way. */
  private judgeStock(product: ProductTarget, result: StockResult): { product: ProductTarget; stock: StockResult } | null {
    const { task } = this.deps;
    this.deps.update({
      ...(result.title ? { productTitle: result.title } : {}),
      ...(result.price !== undefined ? { lastPrice: result.price } : {}),
      ...(result.imageUrl ? { imageUrl: result.imageUrl } : {}),
      productUrl: result.url ?? product.url,
    });
    const time = new Date().toLocaleTimeString();
    if (!result.inStock) {
      this.status('monitoring', `Out of stock (${result.detail}) · checked ${time}`, 'info', this.changed(`oos:${result.detail}`));
      return null;
    }
    if (result.price !== undefined && result.price > task.maxPrice) {
      this.status(
        'monitoring',
        `In stock at ${formatUsd(result.price)}, above your max ${formatUsd(task.maxPrice)} · checked ${time}`,
        'warn',
        this.changed(`price:${result.price}`),
      );
      return null;
    }
    if (task.retailer === 'amazon' && this.deps.settings().amazonSoldByAmazonOnly && result.soldByRetailer === false) {
      this.status('monitoring', `Only third-party sellers have it (skipped: "Sold by Amazon only" is on) · checked ${time}`, 'info', this.changed('3p'));
      return null;
    }
    return { product: { ...product, ...(result.title ? { title: result.title } : {}) }, stock: result };
  }

  private pickHit(query: KeywordQuery, hits: SearchHit[]): SearchHit | null {
    const { task } = this.deps;
    const matching = hits.filter((hit) => matchesKeywords(hit.title, query));
    const eligible = matching.filter((hit) => hit.inStock !== false && (hit.price === undefined || hit.price <= task.maxPrice));
    const time = new Date().toLocaleTimeString();
    if (eligible.length === 0) {
      this.status(
        'monitoring',
        `${matching.length} matching product${matching.length === 1 ? '' : 's'}, none buyable under ${formatUsd(task.maxPrice)} · checked ${time}`,
        'info',
        this.changed(`kw:${matching.length}`),
      );
      return null;
    }
    return eligible[0] ?? null;
  }

  /** Stock check in this account's own session (used right after a waiting room). */
  private async ownSessionStock(ctx: TaskContext, product: ProductTarget): Promise<StockResult | null> {
    try {
      return await this.deps.module.checkStock(this.monitorContextFor(ctx), product);
    } catch (err) {
      if (err instanceof PauseError || err instanceof AbortedError) throw err;
      if (err instanceof QueueError) {
        // The pass did not stick; rejoin the line through the page on the next round.
        ctx.memo.set('queue:rejoin', '1');
        return null;
      }
      this.deps.log('warn', `Stock check in this account's session failed: ${errorMessage(err)}`);
      return null;
    }
  }

  private async confirmHit(ctx: TaskContext, product: ProductTarget): Promise<StockResult | null> {
    try {
      return await this.deps.module.checkStock(this.monitorContextFor(ctx), product);
    } catch (err) {
      if (err instanceof AbortedError) return null;
      this.deps.log('warn', `Could not confirm stock for ${product.title ?? product.productId}: ${errorMessage(err)}`);
      return null;
    }
  }

  private waitForStock(ctx: TaskContext): Promise<Found> {
    const { task, module, monitor } = this.deps;
    const keywords = task.mode === 'keyword' ? parseKeywords(task.input) : undefined;
    const product = task.mode === 'url' ? this.productTarget() : undefined;
    const spec: MonitorSpec = {
      retailer: task.retailer,
      module,
      mode: task.mode,
      zip: ctx.profile.shipping.zip,
      accountId: task.accountId,
      ...(product ? { product } : {}),
      ...(keywords ? { keywords } : {}),
    };

    return new Promise<Found>((resolve, reject) => {
      let settled = false;
      let confirming = false;
      let unsubscribe: () => void = () => undefined;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        ctx.signal.removeEventListener('abort', onAbort);
        this.interrupt = null;
        action();
      };
      const onAbort = () => finish(() => reject(new AbortedError()));
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      this.interrupt = () => finish(() => resolve({ kind: 'resign' }));

      unsubscribe = monitor.subscribe(spec, (event) => {
        if (settled) return;
        switch (event.type) {
          case 'stock': {
            if (!product) return;
            this.deps.update({ failures: 0 });
            const decision = this.judgeStock(product, event.result);
            if (decision) finish(() => resolve({ kind: 'stock', ...decision }));
            return;
          }
          case 'hits': {
            this.deps.update({ failures: 0 });
            if (!keywords || confirming) return;
            const hit = this.pickHit(keywords, event.hits);
            if (!hit) return;
            const target: ProductTarget = { productId: hit.productId, url: hit.url, title: hit.title };
            if (hit.inStock === true) {
              const decision = this.judgeStock(target, {
                inStock: true,
                detail: 'search result',
                title: hit.title,
                url: hit.url,
                ...(hit.price !== undefined ? { price: hit.price } : {}),
                ...(hit.imageUrl ? { imageUrl: hit.imageUrl } : {}),
              });
              if (decision) finish(() => resolve({ kind: 'stock', ...decision }));
              return;
            }
            confirming = true;
            void this.confirmHit(ctx, target).then((result) => {
              confirming = false;
              if (settled || !result) return;
              const decision = this.judgeStock(target, result);
              if (decision) finish(() => resolve({ kind: 'stock', ...decision }));
            });
            return;
          }
          case 'queue':
            finish(() => resolve({ kind: 'queue', detail: event.detail }));
            return;
          case 'challenge':
            finish(() => reject(new PauseError(event.kind, event.detail)));
            return;
          case 'error': {
            const max = this.deps.settings().maxConsecutiveFailures;
            this.deps.update({ failures: event.consecutive });
            this.status('monitoring', `Stock check failed (${event.consecutive}/${max}): ${event.message}`, 'warn');
            if (event.consecutive >= max) {
              finish(() => reject(new FatalError(`Stopped after ${event.consecutive} failed stock checks in a row. Last error: ${event.message}`)));
            }
            return;
          }
        }
      });
      if (this.resignRequested) this.interrupt();
    });
  }

  /** One checkout attempt. Returns true when the task is finished (ordered, or dry run done). */
  private async attempt(ctx: TaskContext, product: ProductTarget, stock: StockResult): Promise<boolean> {
    const { module, task, slots } = this.deps;
    if (slots.inUse >= slots.capacity) {
      this.status('in_stock', `In stock, waiting for a free checkout slot (${slots.inUse}/${slots.capacity} in use)`);
    }
    const release = await slots.acquire(ctx.signal);
    let keepReservation = false;
    try {
      // Cheap early exit; the authoritative check happens right before an order is submitted.
      if (this.deps.groupFull()) throw new GoalReachedError(`Group "${task.groupName ?? 'group'}" already has its ${task.groupGoal} order(s)`);
      if (this.resignRequested) await this.ensureSignedIn(ctx, true);
      // Per-account store limit, then what the budget still pays for.
      const allowed = this.allowedQuantity(product.productId);
      const progress = this.deps.progress();
      const unitPrice = stock.price ?? task.maxPrice;
      const quantity = affordableUnits(task.budget, progress.spent, unitPrice, allowed);
      if (quantity <= 0) {
        throw new GoalReachedError(
          `Budget reached: ${formatUsd(progress.spent)} of ${formatUsd(task.budget)} spent, not enough left for one more at ${formatUsd(unitPrice)}`,
        );
      }
      if (quantity < task.quantity) this.deps.log('info', `Buying ${quantity} instead of ${task.quantity} (store limit or budget)`);
      // The modules read the quantity from the task, so this attempt gets its own copy.
      const actx: TaskContext = quantity === task.quantity ? ctx : { ...ctx, task: { ...ctx.task, quantity } };
      const price = stock.price !== undefined ? ` at ${formatUsd(stock.price)}` : '';
      this.status('in_stock', `In stock${price}, adding ${quantity} to cart`, 'success');
      if (!this.notifiedInStock) {
        this.notifiedInStock = true;
        this.deps.notify('inStock', `In stock${price}`, { ...(stock.price !== undefined ? { price: stock.price } : {}) });
      }

      const cart = await this.withQueue(actx, () => module.addToCart(actx, product, stock), product);
      const unit = cart.unitPrice ?? stock.price;
      if (unit !== undefined && unit > task.maxPrice) throw new PriceLimitError(unit, task.maxPrice);
      this.status('carted', `Carted ${cart.quantity} × ${formatUsd(unit)} (${cart.detail})`, 'success');
      this.deps.notify('carted', `Carted ${cart.quantity} × ${formatUsd(unit)}`, {
        quantity: cart.quantity,
        ...(unit !== undefined ? { price: unit } : {}),
      });

      this.status('checking_out', ctx.dryRun ? 'Checking out (dry run)' : 'Checking out');
      const result = await this.withQueue(actx, () => module.checkout(actx, product, stock, cart), product);
      this.checkoutFailures = 0;
      if (!result.placed) {
        this.status('carted', result.detail, 'success');
        return true;
      }
      const after = this.deps.recordOrder({
        productId: product.productId,
        quantity: cart.quantity,
        amount: result.total ?? this.pendingCost,
        ...(result.orderNumber ? { orderNumber: result.orderNumber } : {}),
      });
      this.pendingCost = null;
      const more = !ordersDone(task, after);
      const summary = (task.maxOrders ?? 1) > 1 || task.budget !== undefined ? ` · ${describeProgress(task, after)}` : '';
      this.deps.update({ ...(result.orderNumber ? { orderNumber: result.orderNumber } : {}) });
      this.status(more ? 'monitoring' : 'checked_out', `${result.detail}${summary}${more ? '. Watching for the next one.' : ''}`, 'success');
      this.deps.saveResult({
        state: 'checked_out',
        message: result.detail,
        at: Date.now(),
        ...(result.orderNumber ? { orderNumber: result.orderNumber } : {}),
      });
      this.deps.notify('checkedOut', `${result.detail}${summary}`, {
        quantity: cart.quantity,
        ...(unit !== undefined ? { price: unit } : {}),
        ...(result.orderNumber ? { orderNumber: result.orderNumber } : {}),
      });
      if (!more) return true;
      // Keep buying: the store empties the cart after an order; go back to watching stock.
      this.closeIdlePage();
      await sleep(this.deps.settings().pollIntervalMs, ctx.signal);
      return false;
    } catch (err) {
      if (err instanceof OutOfStockError) {
        this.closeIdlePage();
        this.status('monitoring', `${err.message}. Back to monitoring.`, 'warn');
        await sleep(this.deps.settings().pollIntervalMs, ctx.signal);
        return false;
      }
      if (err instanceof PriceLimitError) {
        this.closeIdlePage();
        this.status('monitoring', `${err.message}. Not buying; still monitoring.`, 'warn');
        await sleep(this.deps.settings().pollIntervalMs, ctx.signal);
        return false;
      }
      if (err instanceof NeedsSignInError) {
        // Sign in again; the attempt still counts toward the failure limit so a broken
        // sign-in cannot loop forever.
        await this.ensureSignedIn(ctx, true);
        throw new RetailerError('Had to sign in again during checkout');
      }
      // Paused after an order may have been submitted: it keeps counting toward the group
      // limit until you resolve it (restart, stop, or finish it in the window).
      if (err instanceof PauseError && this.releaseOrder) keepReservation = true;
      throw err;
    } finally {
      if (!keepReservation) this.releaseOrder?.();
      this.releaseOrder = null;
      release();
    }
  }

  private pause(err: PauseError): void {
    const handoff = err.handoff && Boolean(this.page?.alive);
    this.keepPage = handoff;
    const message = handoff ? `${err.message} (use Open window)` : err.message;
    this.deps.update({ state: 'paused', message, handoff });
    this.deps.log('warn', `Paused: ${message}`, 'paused');
    this.deps.notify('paused', message);
  }

  private fail(message: string): void {
    this.deps.update({ state: 'failed', message });
    this.deps.log('error', `Failed: ${message}`, 'failed');
    this.deps.saveResult({ state: 'failed', message, at: Date.now() });
    this.deps.notify('failed', message);
  }
}
