// Owns every task's live status, starts and stops runners, enforces the kill switch and
// the global concurrency limit, and keeps paused tasks' windows available for the user.
import { EventEmitter } from 'node:events';
import { formatUsd } from '../../shared/money';
import { parseProductInput, RETAILERS, titleFromUrl } from '../../shared/retailers';
import type {
  ActionResult,
  Profile,
  RetailerId,
  Settings,
  Task,
  TaskResult,
  TaskRuntime,
  TaskState,
  TaskView,
} from '../../shared/types';
import { logBus } from '../core/logger';
import type { NotifyEvent, NotifyKind, Notifier } from '../core/notifier';
import type { AccountsRepo } from '../data/accounts';
import type { CardsRepo } from '../data/cards';
import type { Collection } from '../data/collection';
import type { RetailerModule } from '../retailers/types';
import { BrowserPage } from './browser';
import { GoalReachedError } from './errors';
import { extractOrderNumber, looksLikeConfirmation } from './guards';
import type { StockMonitor } from './monitor';
import { TaskRunner } from './runner';
import { Semaphore } from './semaphore';
import type { SessionManager } from './sessions';

export interface ManagerDeps {
  tasks: Collection<Task>;
  profiles: Collection<Profile>;
  cards: CardsRepo;
  accounts: AccountsRepo;
  getSettings: () => Settings;
  sessions: SessionManager;
  monitor: StockMonitor;
  notifier: Notifier;
  modules: Record<RetailerId, RetailerModule>;
}

interface Handoff {
  page: BrowserPage;
  dispose: () => void;
}

const NOTIFY_TITLES: Record<NotifyKind, string> = {
  inStock: 'In stock',
  queue: 'Waiting room',
  carted: 'Carted',
  checkedOut: 'Checked out',
  paused: 'Paused',
  failed: 'Failed',
};

/** Paused windows are closed after this long to free memory. */
const HANDOFF_TTL_MS = 3 * 60 * 60 * 1000;

export class TaskManager extends EventEmitter {
  private readonly runtimes = new Map<string, TaskRuntime>();
  private readonly runners = new Map<string, TaskRunner>();
  private readonly handoffs = new Map<string, Handoff>();
  /** groupId -> ids of tasks currently allowed to submit an order (group goal accounting). */
  private readonly reservations = new Map<string, Set<string>>();
  /** taskId -> release function of its order reservation (kept while a submit is unresolved). */
  private readonly orderReleases = new Map<string, () => void>();
  readonly slots: Semaphore;

  constructor(private readonly deps: ManagerDeps) {
    super();
    this.slots = new Semaphore(deps.getSettings().maxConcurrency);
    for (const task of deps.tasks.list()) this.runtimes.set(task.id, this.initialRuntime(task));
  }

  private initialRuntime(task: Task): TaskRuntime {
    const last = task.lastResult;
    return {
      taskId: task.id,
      state: last?.state === 'checked_out' ? 'checked_out' : 'idle',
      message: last ? (last.state === 'failed' ? `Last run failed: ${last.message}` : last.message) : 'Ready',
      running: false,
      updatedAt: Date.now(),
      failures: 0,
      handoff: false,
      ...(last?.orderNumber ? { orderNumber: last.orderNumber } : {}),
    };
  }

  runtime(id: string): TaskRuntime {
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      const task = this.deps.tasks.get(id);
      runtime = task
        ? this.initialRuntime(task)
        : { taskId: id, state: 'idle', message: 'Ready', running: false, updatedAt: Date.now(), failures: 0, handoff: false };
      this.runtimes.set(id, runtime);
    }
    return runtime;
  }

  private update(id: string, patch: Partial<TaskRuntime>): void {
    const next: TaskRuntime = { ...this.runtime(id), ...patch, taskId: id, updatedAt: Date.now() };
    this.runtimes.set(id, next);
    this.emit('runtime', next);
  }

  list(): TaskView[] {
    return this.deps.tasks.list().map((task) => ({ ...task, runtime: this.runtime(task.id) }));
  }

  label(task: Task): string {
    if (task.label) return task.label;
    const title = this.runtimes.get(task.id)?.productTitle ?? (task.mode === 'url' ? titleFromUrl(task.input) : null);
    if (title) return title;
    return task.mode === 'keyword' ? `"${task.input}"` : `${RETAILERS[task.retailer].productIdLabel} ${task.productId ?? task.input}`;
  }

  isRunning(id: string): boolean {
    return this.runners.has(id);
  }

  /** Accounts used by running tasks (kept warm by the session keeper). */
  activeAccountIds(): Set<string> {
    const ids = new Set<string>();
    for (const id of this.runners.keys()) {
      const task = this.deps.tasks.get(id);
      if (task) ids.add(task.accountId);
    }
    return ids;
  }

  private validate(task: Task, settings: Settings): string | null {
    if (task.quantity > settings.maxQuantityPerTask) {
      return `Quantity ${task.quantity} is above the global max of ${settings.maxQuantityPerTask} (Settings)`;
    }
    if (!this.deps.profiles.get(task.profileId)) return 'Pick a profile for this task';
    const account = this.deps.accounts.get(task.accountId);
    if (!account) return 'Pick an account for this task';
    if (account.retailer !== task.retailer) return `The account is for ${RETAILERS[account.retailer].name}`;
    if (task.mode === 'url' && !parseProductInput(task.retailer, task.input).ok) return 'The product URL is not valid';
    if (task.groupId && task.groupGoal && this.placedInGroup(task.groupId) >= task.groupGoal) {
      return `Group "${task.groupName ?? 'group'}" already placed its ${task.groupGoal} order(s)`;
    }
    return null;
  }

  private placedInGroup(groupId: string): number {
    return this.deps.tasks.list().filter((t) => t.groupId === groupId && this.runtime(t.id).state === 'checked_out').length;
  }

  /**
   * Called by a task right before it submits an order. Counts placed orders plus orders
   * other accounts are submitting right now, so parallel accounts cannot overshoot the goal.
   */
  private reserveOrder(taskId: string): () => void {
    const task = this.deps.tasks.get(taskId);
    if (!task?.groupId || !task.groupGoal) return () => undefined;
    const groupId = task.groupId;
    const holders = this.reservations.get(groupId) ?? new Set<string>();
    const placed = this.placedInGroup(groupId);
    if (placed + holders.size >= task.groupGoal) {
      throw new GoalReachedError(
        `Group "${task.groupName ?? 'group'}" has ${placed} of ${task.groupGoal} order(s)${holders.size ? ` and ${holders.size} in progress` : ''}; not placing another`,
      );
    }
    holders.add(taskId);
    this.reservations.set(groupId, holders);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.orderReleases.delete(taskId);
      holders.delete(taskId);
      if (holders.size === 0) this.reservations.delete(groupId);
      this.checkGroupGoal(groupId);
    };
    this.orderReleases.set(taskId, release);
    return release;
  }

  /** Drops a reservation a paused task kept after an unclear submit. */
  private releaseReservation(taskId: string): void {
    this.orderReleases.get(taskId)?.();
  }

  /** Once a group has its orders, stop its other tasks (except ones mid-submit). */
  private checkGroupGoal(groupId: string): void {
    const members = this.deps.tasks.list().filter((t) => t.groupId === groupId);
    const goal = members[0]?.groupGoal;
    if (!goal) return;
    const placed = this.placedInGroup(groupId);
    if (placed < goal) return;
    const busy = this.reservations.get(groupId) ?? new Set<string>();
    // Leave alone tasks that already ordered (they are finishing up) and ones mid-submit.
    const others = members
      .filter((t) => (this.runners.has(t.id) || this.handoffs.has(t.id)) && !busy.has(t.id) && this.runtime(t.id).state !== 'checked_out')
      .map((t) => t.id);
    if (others.length === 0) return;
    logBus.info(`Group "${members[0]?.groupName ?? 'group'}" reached ${placed}/${goal} order(s); stopping ${others.length} other task(s)`);
    void this.stop(others, 'idle', `Group goal reached (${placed}/${goal} orders)`);
  }

  start(ids: string[]): ActionResult {
    const settings = this.deps.getSettings();
    if (settings.killSwitch) return { ok: false, message: 'The kill switch is engaged. Release it before starting tasks.' };
    let started = 0;
    const problems: string[] = [];
    for (const id of ids) {
      if (this.runners.has(id)) continue;
      const task = this.deps.tasks.get(id);
      if (!task) continue;
      const problem = this.validate(task, settings);
      if (problem) {
        problems.push(`${this.label(task)}: ${problem}`);
        this.update(id, { message: problem });
        continue;
      }
      this.launch(task);
      started++;
    }
    if (problems.length) return { ok: started > 0, message: `Started ${started}. ${problems.join(' · ')}` };
    return { ok: true, message: started === 1 ? 'Task started' : `Started ${started} tasks` };
  }

  /** Starts every stopped task except ones that already checked out (avoids buying twice). */
  startAll(): ActionResult {
    const ids = this.deps.tasks
      .list()
      .filter((t) => !this.runners.has(t.id) && this.runtime(t.id).state !== 'checked_out')
      .map((t) => t.id);
    if (ids.length === 0) return { ok: true, message: 'Nothing to start' };
    return this.start(ids);
  }

  private launch(task: Task): void {
    // Starting again means you checked: a kept order reservation no longer applies.
    this.releaseReservation(task.id);
    const handoff = this.handoffs.get(task.id);
    if (handoff) {
      handoff.dispose();
      this.handoffs.delete(task.id);
    }
    const { deps } = this;
    const runner = new TaskRunner(
      {
        task,
        label: () => this.label(task),
        module: deps.modules[task.retailer],
        profile: () => deps.profiles.get(task.profileId),
        card: () => deps.cards.get(task.profileId),
        account: () => deps.accounts.get(task.accountId),
        settings: deps.getSettings,
        sessions: deps.sessions,
        monitor: deps.monitor,
        slots: this.slots,
        update: (patch) => this.update(task.id, patch),
        log: (level, message, state) => logBus.log({ level, message, taskId: task.id, retailer: task.retailer, ...(state ? { state } : {}) }),
        notify: (kind, detail, extra) => this.notify(task, kind, detail, extra),
        accountSession: (state, message) => deps.accounts.setSession(task.accountId, state, message),
        saveResult: (result) => this.saveResult(task.id, result),
        reserveOrder: () => this.reserveOrder(task.id),
        groupFull: () => {
          const current = deps.tasks.get(task.id);
          if (!current?.groupId || !current.groupGoal) return false;
          const inProgress = this.reservations.get(current.groupId)?.size ?? 0;
          return this.placedInGroup(current.groupId) + inProgress >= current.groupGoal;
        },
      },
      handoff?.page.alive ? handoff.page : null,
    );
    this.runners.set(task.id, runner);
    this.update(task.id, { state: 'monitoring', message: 'Starting', running: true, handoff: false, failures: 0 });
    logBus.log({ level: 'info', message: `Started (${deps.getSettings().dryRun ? 'dry run' : 'live'})`, taskId: task.id, retailer: task.retailer });
    runner.start();
    void runner.done.then(() => {
      if (this.runners.get(task.id) === runner) this.runners.delete(task.id);
      const page = runner.releasePage();
      if (page) this.adoptHandoff(task.id, page);
    });
  }

  async stop(ids: string[], state: TaskState = 'idle', message = 'Stopped'): Promise<void> {
    await Promise.all(
      ids.map(async (id) => {
        const runner = this.runners.get(id);
        const hadHandoff = this.handoffs.has(id);
        if (runner) {
          this.runners.delete(id);
          await runner.stop();
          runner.releasePage()?.close();
        }
        this.closeHandoff(id);
        this.releaseReservation(id);
        if (runner || hadHandoff) this.update(id, { state, message, running: false, handoff: false });
      }),
    );
  }

  async stopAll(): Promise<void> {
    await this.stop([...new Set([...this.runners.keys(), ...this.handoffs.keys()])]);
  }

  /** Kill switch: abort everything immediately and close every automation window. */
  async engageKillSwitch(): Promise<void> {
    const ids = [...new Set([...this.runners.keys(), ...this.handoffs.keys()])];
    await this.stop(ids, 'paused', 'Kill switch engaged');
    this.deps.monitor.stopAll();
    if (ids.length) logBus.warn(`Kill switch engaged: stopped ${ids.length} task(s)`);
  }

  async remove(ids: string[]): Promise<void> {
    await this.stop(ids);
    this.deps.tasks.remove(ids);
    for (const id of ids) this.runtimes.delete(id);
  }

  onSettingsChanged(previous: Settings, next: Settings): void {
    this.slots.setLimit(next.maxConcurrency);
    if (!previous.killSwitch && next.killSwitch) void this.engageKillSwitch();
  }

  /** The session keeper found this account signed out: running tasks sign in again. */
  onAccountSignedOut(accountId: string): void {
    for (const [id, runner] of this.runners) {
      if (this.deps.tasks.get(id)?.accountId === accountId) runner.requestSignIn();
    }
  }

  /** Shows the task's window, or opens the product in the account's session so you can look. */
  async showWindow(id: string): Promise<ActionResult> {
    if (this.runners.get(id)?.showWindow()) return { ok: true, message: 'Window shown' };
    const handoff = this.handoffs.get(id);
    if (handoff?.page.alive) {
      handoff.page.show();
      return { ok: true, message: 'Window shown' };
    }
    const task = this.deps.tasks.get(id);
    if (!task) return { ok: false, message: 'Task not found' };
    const account = this.deps.accounts.get(task.accountId);
    if (!account) return { ok: false, message: 'Pick an account for this task first' };
    const handle = await this.deps.sessions.forAccount(account.id, task.retailer);
    const page = BrowserPage.open(handle, `${RETAILERS[task.retailer].name} · ${this.label(task)}`, true);
    const parsed = task.mode === 'url' ? parseProductInput(task.retailer, task.input) : null;
    const url = parsed?.ok ? parsed.product.url : this.deps.modules[task.retailer].homeUrl;
    page.win.webContents.loadURL(url).catch(() => undefined);
    this.adoptHandoff(id, page);
    return { ok: true, message: 'Opened the product in this account’s session window' };
  }

  /**
   * Keeps a paused task's window open. If the user finishes the order in it by hand, the
   * confirmation page is detected and the task is marked checked out.
   */
  private adoptHandoff(taskId: string, page: BrowserPage): void {
    this.closeHandoff(taskId);
    const wc = page.win.webContents;
    const check = async () => {
      const snapshot = await page.snapshot();
      if (!looksLikeConfirmation(snapshot.url, snapshot.text)) return;
      const task = this.deps.tasks.get(taskId);
      const orderNumber = extractOrderNumber(snapshot.text) ?? undefined;
      const message = `Order completed by you in the session window${orderNumber ? ` (#${orderNumber})` : ''}`;
      this.update(taskId, { state: 'checked_out', message, handoff: false, ...(orderNumber ? { orderNumber } : {}) });
      this.saveResult(taskId, { state: 'checked_out', message, at: Date.now(), ...(orderNumber ? { orderNumber } : {}) });
      // Now counted as placed, so its reservation must not count twice.
      this.releaseReservation(taskId);
      if (task) {
        logBus.log({ level: 'success', message, taskId, retailer: task.retailer, state: 'checked_out' });
        this.notify(task, 'checkedOut', message, orderNumber ? { orderNumber } : {});
        if (task.groupId) this.checkGroupGoal(task.groupId);
      }
    };
    const onLoad = () => void check();
    wc.on('did-stop-loading', onLoad);
    const timer = setTimeout(() => this.closeHandoff(taskId), HANDOFF_TTL_MS);
    this.handoffs.set(taskId, {
      page,
      dispose: () => {
        clearTimeout(timer);
        if (!wc.isDestroyed()) wc.off('did-stop-loading', onLoad);
      },
    });
    this.update(taskId, { handoff: true });
  }

  private closeHandoff(taskId: string): void {
    const handoff = this.handoffs.get(taskId);
    if (!handoff) return;
    handoff.dispose();
    handoff.page.close();
    this.handoffs.delete(taskId);
    this.update(taskId, { handoff: false });
  }

  private saveResult(taskId: string, result: TaskResult): void {
    const task = this.deps.tasks.get(taskId);
    if (task) this.deps.tasks.replace({ ...task, lastResult: result });
  }

  private notify(task: Task, kind: NotifyKind, detail: string, extra: Partial<NotifyEvent> = {}): void {
    const runtime = this.runtime(task.id);
    const profile = this.deps.profiles.get(task.profileId);
    const price = extra.price ?? runtime.lastPrice;
    this.deps.notifier.notify({
      kind,
      title: `${NOTIFY_TITLES[kind]} · ${RETAILERS[task.retailer].name}`,
      detail: price !== undefined && kind === 'inStock' ? `${detail} (max ${formatUsd(task.maxPrice)})` : detail,
      retailer: task.retailer,
      taskLabel: this.label(task),
      quantity: task.quantity,
      ...(runtime.productUrl ? { productUrl: runtime.productUrl } : {}),
      ...(runtime.imageUrl ? { imageUrl: runtime.imageUrl } : {}),
      ...(profile ? { profileName: profile.name } : {}),
      ...extra,
      ...(price !== undefined ? { price } : {}),
    });
  }

  async shutdown(): Promise<void> {
    await this.stop([...new Set([...this.runners.keys(), ...this.handoffs.keys()])]);
    this.deps.monitor.stopAll();
  }
}
