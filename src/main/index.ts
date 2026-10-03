// App entry: wires storage, the task engine, IPC and the main window together.
import { app, BrowserWindow, dialog, Menu, nativeImage, safeStorage } from 'electron';
import iconDataUrl from '../../build/icon.png';
import type { Profile, Task } from '../shared/types';
import { logBus } from './core/logger';
import { Notifier } from './core/notifier';
import { paths } from './core/paths';
import { encryptionStatus } from './core/secrets';
import { AccountsRepo } from './data/accounts';
import { CatalogRepo } from './data/catalog';
import { Collection } from './data/collection';
import { normalizeProfile, normalizeTask } from './data/normalize';
import { OverridesRepo } from './data/overrides';
import { SettingsRepo } from './data/settings';
import { AccountWindows } from './engine/accountWindow';
import { SessionKeeper } from './engine/keepalive';
import { TaskManager } from './engine/manager';
import { StockMonitor } from './engine/monitor';
import { SessionManager } from './engine/sessions';
import { registerIpc, wireEvents } from './ipc';
import { createRetailerModules } from './retailers/registry';
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
  const accounts = new AccountsRepo(onError);
  const catalog = new CatalogRepo(onError);
  const overrides = new OverridesRepo(onError);
  const modules = createRetailerModules(overrides);
  const getSettings = () => settings.get();

  const icon = nativeImage.createFromDataURL(iconDataUrl);
  const sessions = new SessionManager(getSettings);
  const monitor = new StockMonitor(sessions, getSettings);
  const notifier = new Notifier(getSettings, icon, showMainWindow);
  const manager = new TaskManager({ tasks, profiles, accounts, getSettings, sessions, monitor, notifier, modules });
  const keeper = new SessionKeeper({
    accounts,
    sessions,
    modules,
    getSettings,
    activeAccountIds: () => manager.activeAccountIds(),
    onSignedOut: (accountId) => manager.onAccountSignedOut(accountId),
  });
  const accountWindows = new AccountWindows(accounts, sessions, modules, (accountId) => void keeper.check(accountId));

  const services = {
    mainWindow: () => mainWindow,
    settings,
    tasks,
    profiles,
    accounts,
    catalog,
    overrides,
    manager,
    sessions,
    keeper,
    accountWindows,
    notifier,
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
      accountWindows.closeAll();
      for (const store of [settings, tasks, profiles, accounts]) store.flush();
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
