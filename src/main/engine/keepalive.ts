// Keeps signed-in sessions warm: every few minutes each account used by a running task
// makes one light, authenticated request. If an account turns out to be signed out, its
// running tasks sign in again before their next checkout instead of at drop time.
import { RETAILERS } from '../../shared/retailers';
import type { AccountSessionState, RetailerId, Settings } from '../../shared/types';
import { logBus } from '../core/logger';
import type { AccountsRepo } from '../data/accounts';
import type { RetailerModule } from '../retailers/types';
import { errorMessage, PauseError } from './errors';
import type { SessionManager } from './sessions';

export interface KeeperDeps {
  accounts: AccountsRepo;
  sessions: SessionManager;
  modules: Record<RetailerId, RetailerModule>;
  getSettings: () => Settings;
  activeAccountIds: () => Set<string>;
  onSignedOut: (accountId: string) => void;
}

export class SessionKeeper {
  private timer: NodeJS.Timeout | null = null;
  private readonly lastCheck = new Map<string, number>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: KeeperDeps) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    const minutes = this.deps.getSettings().sessionKeepAliveMinutes;
    if (minutes <= 0) return;
    const now = Date.now();
    for (const accountId of this.deps.activeAccountIds()) {
      if (now - (this.lastCheck.get(accountId) ?? 0) >= minutes * 60_000) await this.check(accountId);
    }
  }

  /** Checks one account's session now. Returns true/false, or null when it cannot tell. */
  async check(accountId: string): Promise<boolean | null> {
    const { accounts, sessions, modules, getSettings } = this.deps;
    const account = accounts.get(accountId);
    if (!account || this.inFlight.has(accountId)) return null;
    this.inFlight.add(accountId);
    this.lastCheck.set(accountId, Date.now());
    const set = (state: AccountSessionState, message: string) => accounts.setSession(accountId, state, message);
    set('checking', 'Checking session');
    try {
      const handle = await sessions.forAccount(accountId, account.retailer);
      const result = await modules[account.retailer].checkSignedIn({
        handle,
        http: handle.http,
        settings: getSettings(),
        signal: AbortSignal.timeout(45_000),
      });
      if (result === true) set('signed_in', 'Signed in');
      else if (result === false) {
        set('signed_out', 'Signed out');
        this.deps.onSignedOut(accountId);
      } else set('unknown', 'Could not confirm from here; checkout will verify');
      return result;
    } catch (err) {
      const message = err instanceof PauseError ? err.message : `Check failed: ${errorMessage(err)}`;
      set('needs_attention', message);
      logBus.warn(`${RETAILERS[account.retailer].name} account "${account.label}": ${message}`);
      return null;
    } finally {
      this.inFlight.delete(accountId);
    }
  }
}
