// Assisted account creation. For each email a normal, visible store window opens on the
// sign-up page in a new isolated session, with the form filled in from a profile. The user
// clicks the store's own "Create account" button and enters any code the store emails or
// texts; the app never solves CAPTCHAs, makes up emails or phone numbers, or skips a
// verification step. "Done" checks the session and saves the account (encrypted); that
// session becomes the account's session, so it starts out signed in.
import { randomInt, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { BrowserWindow } from 'electron';
import { RETAILERS } from '../../shared/retailers';
import type { ActionResult, Profile, RetailerId, Settings, SignupItemStatus, SignupJobView, SignupRequest } from '../../shared/types';
import { logBus } from '../core/logger';
import type { AccountsRepo } from '../data/accounts';
import type { Collection } from '../data/collection';
import type { RetailerModule } from '../retailers/types';
import { pageFillSignup, type SignupValues } from './pageScripts';
import type { SessionManager } from './sessions';

const WORLD_ID = 1339;
const MAX_EMAILS = 50;
const FILL_DELAYS_MS = [0, 1500, 4000];
const EMAIL = /^[^\s@:,;]+@[^\s@:,;]+\.[^\s@:,;]+$/;

/** A random 16-character password with upper and lower case letters, digits and a symbol. */
export function generatePassword(length = 16): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%*?'];
  const all = sets.join('');
  const chars = sets.map((set) => set[randomInt(set.length)]!);
  while (chars.length < length) chars.push(all[randomInt(all.length)]!);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

/** One email per line (commas and spaces also separate). Returns valid unique emails and the rest. */
export function parseEmails(text: string): { emails: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const email = raw.trim();
    if (!email) continue;
    if (!EMAIL.test(email)) {
      invalid.push(email);
      continue;
    }
    if (seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    emails.push(email);
  }
  return { emails, invalid };
}

interface Item {
  /** Becomes the account id, so the sign-up session is the account's session. */
  id: string;
  email: string;
  password: string;
  status: SignupItemStatus;
  message: string;
}

interface Job {
  retailer: RetailerId;
  items: Item[];
  current: number;
  values: Omit<SignupValues, 'email' | 'password'>;
  profileId: string;
  linkProfile: boolean;
  labelPrefix: string;
}

export interface SignupDeps {
  accounts: AccountsRepo;
  profiles: Collection<Profile>;
  sessions: SessionManager;
  modules: Record<RetailerId, RetailerModule>;
  getSettings: () => Settings;
}

export class SignupAssistant extends EventEmitter {
  private job: Job | null = null;
  private win: BrowserWindow | null = null;
  private busy = false;

  constructor(private readonly deps: SignupDeps) {
    super();
  }

  view(): SignupJobView | null {
    if (!this.job) return null;
    return {
      retailer: this.job.retailer,
      items: this.job.items.map(({ email, status, message }) => ({ email, status, message })),
      current: this.job.current,
    };
  }

  private changed(): void {
    this.emit('changed', this.view());
  }

  async start(request: SignupRequest): Promise<SignupJobView> {
    if (this.job && this.job.current >= 0) throw new Error('Account creation is already running. Finish or stop it first.');
    const profile = this.deps.profiles.get(request.profileId);
    if (!profile) throw new Error('Pick a profile for the name and phone');
    const { emails, invalid } = parseEmails(request.emails);
    if (invalid.length) throw new Error(`Not an email address: ${invalid.slice(0, 3).join(', ')}`);
    if (emails.length === 0) throw new Error('Add at least one email');
    if (emails.length > MAX_EMAILS) throw new Error(`At most ${MAX_EMAILS} emails at a time`);
    const saved = new Set(
      this.deps.accounts
        .list()
        .filter((a) => a.retailer === request.retailer)
        .map((a) => this.deps.accounts.get(a.id)?.email.toLowerCase()),
    );
    this.job = {
      retailer: request.retailer,
      items: emails.map((email) => {
        const exists = saved.has(email.toLowerCase());
        return {
          id: randomUUID(),
          email,
          password: request.passwordMode === 'same' ? request.password : generatePassword(),
          status: exists ? 'skipped' : 'waiting',
          message: exists ? 'Already saved in Accounts' : '',
        };
      }),
      current: -1,
      values: { firstName: profile.shipping.firstName, lastName: profile.shipping.lastName, phone: profile.shipping.phone },
      profileId: profile.id,
      linkProfile: request.linkProfile,
      labelPrefix: request.labelPrefix.trim() || RETAILERS[request.retailer].name,
    };
    await this.advance();
    return this.view()!;
  }

  /** The user says they finished the current sign-up: confirm the session and save the account. */
  async done(force: boolean): Promise<ActionResult> {
    const job = this.job;
    const item = job && job.current >= 0 ? job.items[job.current] : undefined;
    if (!job || !item) return { ok: false, message: 'Nothing is being created right now' };
    if (this.busy) return { ok: false, message: 'Still checking' };
    this.busy = true;
    try {
      const signedIn = await this.checkSignedIn(job.retailer, item.id);
      if (signedIn === false && !force) {
        return {
          ok: false,
          message: 'Not signed in yet. Create the account in the store window (and enter any code the store sends), then click Done again.',
        };
      }
      this.save(job, item, signedIn);
      this.closeWindow();
      await this.advance();
      return { ok: true, message: `Saved ${item.email}` };
    } finally {
      this.busy = false;
    }
  }

  async skip(): Promise<ActionResult> {
    const job = this.job;
    const item = job && job.current >= 0 ? job.items[job.current] : undefined;
    if (!job || !item) return { ok: false, message: 'Nothing is being created right now' };
    this.closeWindow();
    await this.discard(item, 'Skipped');
    await this.advance();
    return { ok: true, message: `Skipped ${item.email}` };
  }

  /** Stops the run (accounts already saved stay) and forgets the list. */
  async cancel(): Promise<ActionResult> {
    const job = this.job;
    this.closeWindow();
    if (job && job.current >= 0) await this.discard(job.items[job.current]!, 'Stopped');
    this.job = null;
    this.changed();
    return { ok: true, message: 'Stopped account creation' };
  }

  closeAll(): void {
    this.closeWindow();
  }

  private save(job: Job, item: Item, signedIn: boolean | null): void {
    const count = this.deps.accounts.list().filter((a) => a.retailer === job.retailer).length;
    this.deps.accounts.create(
      {
        retailer: job.retailer,
        label: `${job.labelPrefix} #${count + 1}`.slice(0, 60),
        email: item.email,
        password: item.password,
        ...(job.linkProfile ? { profileId: job.profileId } : {}),
      },
      item.id,
    );
    if (signedIn === true) this.deps.accounts.setSession(item.id, 'signed_in', 'Signed in');
    else this.deps.accounts.setSession(item.id, 'unknown', 'Created; sign-in not confirmed');
    item.status = 'saved';
    item.message = signedIn === true ? 'Saved, signed in' : 'Saved (sign-in not confirmed)';
    logBus.log({ level: 'success', message: `${RETAILERS[job.retailer].name}: new account saved (${job.labelPrefix} #${count + 1})`, retailer: job.retailer });
  }

  private async discard(item: Item, message: string): Promise<void> {
    item.status = 'skipped';
    item.message = message;
    await this.deps.sessions.clearAccount(item.id).catch(() => undefined);
  }

  private async checkSignedIn(retailer: RetailerId, id: string): Promise<boolean | null> {
    try {
      const handle = await this.deps.sessions.forAccount(id, retailer);
      return await this.deps.modules[retailer].checkSignedIn({
        handle,
        http: handle.http,
        settings: this.deps.getSettings(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      return null;
    }
  }

  /** Opens the next waiting email, or finishes. */
  private async advance(): Promise<void> {
    const job = this.job;
    if (!job) return;
    const next = job.items.findIndex((i) => i.status === 'waiting');
    job.current = next;
    if (next < 0) {
      const saved = job.items.filter((i) => i.status === 'saved').length;
      if (saved) logBus.info(`Account creation finished: ${saved} ${RETAILERS[job.retailer].name} account(s) saved`);
      this.changed();
      return;
    }
    const item = job.items[next]!;
    item.status = 'open';
    item.message = 'Finish the sign-up in the store window';
    this.changed();
    await this.openWindow(job, item, next);
  }

  private async openWindow(job: Job, item: Item, index: number): Promise<void> {
    const handle = await this.deps.sessions.forAccount(item.id, job.retailer);
    const pending = job.items.filter((i) => i.status === 'waiting' || i.status === 'open').length;
    const win = new BrowserWindow({
      width: 1120,
      height: 900,
      title: `Create account · ${RETAILERS[job.retailer].name} · ${item.email} (${index + 1} of ${job.items.length}, ${pending} left)`,
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        session: handle.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
      },
    });
    this.win = win;
    const wc = win.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url)) wc.loadURL(url).catch(() => undefined);
      return { action: 'deny' };
    });
    wc.on('login', (event, _details, authInfo, callback) => {
      if (authInfo.isProxy && handle.proxy?.username) {
        event.preventDefault();
        callback(handle.proxy.username, handle.proxy.password ?? '');
      }
    });
    win.on('page-title-updated', (event) => event.preventDefault());

    const values: SignupValues = { email: item.email, password: item.password, ...job.values };
    const fill = () => {
      for (const delay of FILL_DELAYS_MS) {
        setTimeout(() => {
          if (win.isDestroyed()) return;
          wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: `(${pageFillSignup.toString()})(${JSON.stringify(values)})` }]).catch(() => undefined);
        }, delay);
      }
    };
    wc.on('did-stop-loading', fill);
    wc.on('did-navigate-in-page', fill);

    // Closing the window yourself counts as "done" when the account exists, else as a skip.
    win.on('closed', () => {
      if (this.win !== win) return;
      this.win = null;
      if (this.job === job && job.items[job.current] === item && item.status === 'open') {
        void (async () => {
          const signedIn = await this.checkSignedIn(job.retailer, item.id);
          if (this.job !== job || item.status !== 'open') return;
          if (signedIn === true) this.save(job, item, true);
          else await this.discard(item, 'Window closed before the account was made');
          await this.advance();
        })();
      }
    });
    wc.loadURL(this.deps.modules[job.retailer].signUpUrl).catch(() => undefined);
  }

  private closeWindow(): void {
    const win = this.win;
    this.win = null;
    if (win && !win.isDestroyed()) win.destroy();
  }
}
