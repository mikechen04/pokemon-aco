// "Sign in" from the Accounts tab: a normal, visible window on the retailer's sign-in page,
// in that account's isolated session. The saved email and password are filled in; you
// handle 2FA or any verification yourself. When you close it, the session is checked.
import { BrowserWindow } from 'electron';
import { RETAILERS } from '../../shared/retailers';
import type { ActionResult, RetailerId } from '../../shared/types';
import type { AccountsRepo } from '../data/accounts';
import type { RetailerModule } from '../retailers/types';
import { pageExists, pageFill } from './pageScripts';
import type { SessionManager } from './sessions';

const EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name="email"]',
  'input[name="username"]',
  'input[autocomplete="username"]',
  '#username',
  '#ap_email',
  '#fld-e',
];
const PASSWORD_SELECTORS = ['input[type="password"]'];
const WORLD_ID = 1338;

export class AccountWindows {
  private readonly windows = new Map<string, BrowserWindow>();

  constructor(
    private readonly accounts: AccountsRepo,
    private readonly sessions: SessionManager,
    private readonly modules: Record<RetailerId, RetailerModule>,
    private readonly onClosed: (accountId: string) => void,
  ) {}

  async open(accountId: string): Promise<ActionResult> {
    const existing = this.windows.get(accountId);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return { ok: true, message: 'Sign-in window is already open' };
    }
    const account = this.accounts.get(accountId);
    if (!account) return { ok: false, message: 'Account not found' };
    const handle = await this.sessions.forAccount(account.id, account.retailer);
    const win = new BrowserWindow({
      width: 1120,
      height: 880,
      title: `Sign in · ${RETAILERS[account.retailer].name} · ${account.label}`,
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
    this.windows.set(accountId, win);
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

    // Fill each field once, like a password manager would.
    let emailFilled = false;
    let passwordFilled = false;
    const run = async <A extends unknown[], R>(fn: (...args: A) => R, ...args: A): Promise<R | null> => {
      try {
        return (await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: `(${fn.toString()})(...${JSON.stringify(args)})` }])) as R;
      } catch {
        return null;
      }
    };
    wc.on('did-stop-loading', () => {
      void (async () => {
        const current = this.accounts.get(accountId);
        if (!current) return;
        if (!emailFilled && (await run(pageExists, EMAIL_SELECTORS))) emailFilled = Boolean(await run(pageFill, EMAIL_SELECTORS, current.email));
        if (!passwordFilled && current.password && (await run(pageExists, PASSWORD_SELECTORS))) {
          passwordFilled = Boolean(await run(pageFill, PASSWORD_SELECTORS, current.password));
        }
      })();
    });
    win.on('closed', () => {
      this.windows.delete(accountId);
      this.onClosed(accountId);
    });
    wc.loadURL(this.modules[account.retailer].signInUrl).catch(() => undefined);
    return { ok: true, message: 'Sign in in the new window, then close it' };
  }

  close(accountId: string): void {
    const win = this.windows.get(accountId);
    if (win && !win.isDestroyed()) win.destroy();
    this.windows.delete(accountId);
  }

  closeAll(): void {
    for (const id of [...this.windows.keys()]) this.close(id);
  }
}
