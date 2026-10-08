// App entry: wires storage, the task engine, IPC and the main window together.
import { app, BrowserWindow, dialog, Menu, nativeImage, safeStorage } from 'electron';
import iconDataUrl from '../../build/icon.png';
import type { Profile, Settings, Task } from '../shared/types';
import { logBus } from './core/logger';
import { Notifier } from './core/notifier';
import { paths } from './core/paths';
import { encryptionStatus } from './core/secrets';
import { AccountsRepo } from './data/accounts';
import { CardsRepo, summarizeCard } from './data/cards';
import { CatalogRepo } from './data/catalog';
import { Collection } from './data/collection';
import { normalizeProfile, normalizeTask } from './data/normalize';
import { OverridesRepo } from './data/overrides';
import { PurchaseLedger } from './data/purchases';
import { SettingsRepo } from './data/settings';
import { AccountWindows } from './engine/accountWindow';
import { SignupAssistant } from './engine/signup';
import { SessionKeeper } from './engine/keepalive';
import { TaskManager } from './engine/manager';
import { StockMonitor } from './engine/monitor';
import { SessionManager } from './engine/sessions';
import { registerIpc, wireEvents } from './ipc';
import { createRetailerModules } from './retailers/registry';
import { Updater } from './updater';
import { createMainWindow } from './window';

/** Must match electron-builder's appId so Windows notifications are attributed to the app. */
const APP_USER_MODEL_ID = 'com.mikechen04.pokemonaco';

let mainWindow: BrowserWindow | null = null;

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Keeps each profile's card summary in step with the encrypted card file (for example after
 * cards.json could not be decrypted), and deletes cards whose profile is gone.
 */
function syncStoredCards(profiles: Collection<Profile>, cards: CardsRepo): void {
  for (const profile of profiles.list()) {
    const stored = cards.get(profile.id);
    const summary = stored ? summarizeCard(stored) : null;
    if (JSON.stringify(summary) === JSON.stringify(profile.card)) continue;
    if (profile.card && !stored) logBus.warn(`The stored card for profile "${profile.name}" could not be loaded. Add it again in Profiles.`);
    profiles.replace({ ...profile, card: summary, ...(summary ? { cardLast4: summary.last4 } : {}) });
  }
  const removed = cards.removeOrphans(new Set(profiles.list().map((p) => p.id)));
  if (removed > 0) logBus.info(`Deleted ${removed} stored card(s) whose profile no longer exists`);
}

async function start(): Promise<void> {
  Menu.setApplicationMenu(process.env.VITE_DEV_SERVER_URL ? Menu.buildFromTemplate([{ role: 'viewMenu' }]) : null);
  await logBus.init(paths.logs);
  const onError = (message: string) => logBus.error(message);
  // Developer escape hatch for Linux machines without a keyring. Weak (obfuscation only) and
  // reported as such in the UI. Windows always uses DPAPI; this does nothing there.
  if (process.platform === 'linux' && process.env.ACO_ALLOW_WEAK_ENCRYPTION === '1') safeStorage.setUsePlainTextEncryption(true);

  const settings = new SettingsRepo(onError);
  const tasks = new Collection<Task>(paths.dataFile('tasks.json'), normalizeTask, onError);
  const profiles = new Collection<Profile>(paths.dataFile('profiles.json'), normalizeProfile, onError);
  const cards = new CardsRepo(onError);
  syncStoredCards(profiles, cards);
  const accounts = new AccountsRepo(onError);
  const purchases = new PurchaseLedger(onError);
  const catalog = new CatalogRepo(onError);
  const overrides = new OverridesRepo(onError);
  const modules = createRetailerModules(overrides);
  const getSettings = () => settings.get();

  const icon = nativeImage.createFromDataURL(iconDataUrl);
  const sessions = new SessionManager(getSettings);
  const monitor = new StockMonitor(sessions, getSettings);
  const notifier = new Notifier(getSettings, icon, showMainWindow);
  const manager = new TaskManager({ tasks, profiles, cards, accounts, purchases, getSettings, sessions, monitor, notifier, modules });
  const keeper = new SessionKeeper({
    accounts,
    sessions,
    modules,
    getSettings,
    activeAccountIds: () => manager.activeAccountIds(),
    onSignedOut: (accountId) => manager.onAccountSignedOut(accountId),
  });
  const accountWindows = new AccountWindows(accounts, sessions, modules, (accountId) => void keeper.check(accountId));
  const signup = new SignupAssistant({ accounts, profiles, sessions, modules, getSettings });
  const updater = new Updater({ getSettings, busy: () => manager.list().some((t) => manager.isRunning(t.id)) });
  const syncCatalog = async () => {
    const keep = new Set(tasks.list().flatMap((t) => (t.catalogEntryId ? [t.catalogEntryId] : [])));
    const result = await catalog.sync(settings.get().catalogFeedUrl, keep);
    logBus.log({ level: result.ok ? 'info' : 'warn', message: result.message });
    return result;
  };

  const services = {
    mainWindow: () => mainWindow,
    settings,
    tasks,
    profiles,
    cards,
    accounts,
    purchases,
    catalog,
    overrides,
    manager,
    sessions,
    keeper,
    accountWindows,
    signup,
    notifier,
    updater,
    syncCatalog,
  };
  registerIpc(services);
  wireEvents(services);
  keeper.start();

  const encryption = encryptionStatus();
  if (!encryption.available) logBus.error('OS encryption is unavailable: accounts cannot be saved until it is.');
  else if (!encryption.strong) logBus.warn(`Encryption backend "${encryption.backend}" is weak on this system; accounts are only obfuscated.`);
  if (settings.get().killSwitch) logBus.warn('Kill switch is engaged from the last session. Release it to start tasks.');
  logBus.info(`Pokemon ACO ${app.getVersion()} started${settings.get().dryRun ? ' (dry run is ON: no orders will be placed)' : ''}`);

  mainWindow = createMainWindow(icon);
  updater.start();
  // Catalog feed: shortly after start, then every 6 hours (the feed is rebuilt once a day).
  const autoSync = () => {
    if (settings.get().catalogAutoSync) void syncCatalog();
  };
  const catalogTimers = [setTimeout(autoSync, 8000), setInterval(autoSync, 6 * 60 * 60 * 1000)];
  let feedSettings = `${settings.get().catalogAutoSync}|${settings.get().catalogFeedUrl}`;
  settings.on('changed', (next: Settings) => {
    // Sync right away when auto-sync is turned on or the feed URL changes.
    const current = `${next.catalogAutoSync}|${next.catalogFeedUrl}`;
    if (current !== feedSettings) autoSync();
    feedSettings = current;
  });
  mainWindow.on('close', (event) => {
    const running = manager.list().filter((t) => manager.isRunning(t.id)).length;
    if (running === 0 || !mainWindow) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Stop tasks and quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Tasks are running',
      message: `${running} task(s) are running. Quit and stop them?`,
    });
    if (choice === 1) event.preventDefault();
  });
  // Hidden automation windows keep 'window-all-closed' from firing, so quit explicitly.
  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });

  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void (async () => {
      try {
        await Promise.race([manager.shutdown(), new Promise((resolve) => setTimeout(resolve, 5000))]);
      } catch {
        // shutting down regardless
      }
      keeper.stop();
      updater.stop();
      for (const timer of catalogTimers) clearTimeout(timer);
      accountWindows.closeAll();
      signup.closeAll();
      for (const store of [settings, tasks, profiles, cards, accounts, purchases]) store.flush();
      logBus.flushSync();
      app.quit();
    })();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(APP_USER_MODEL_ID);
  app.on('second-instance', showMainWindow);
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(start, (err: unknown) => {
    dialog.showErrorBox('Pokemon ACO could not start', err instanceof Error ? err.message : String(err));
    app.quit();
  });
}
