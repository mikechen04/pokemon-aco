// Auto-update from this repo's GitHub Releases (electron-updater). Only active in the
// installed Windows app. Checks shortly after start and every 6 hours. Downloads wait until
// no task is running, so an update never competes with a drop for bandwidth. A downloaded
// update installs when the app quits, or right away with "Restart and install".
import { EventEmitter } from 'node:events';
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { AppUpdateStatus, Settings } from '../shared/types';
import { logBus } from './core/logger';
import { redact } from './core/redact';

const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const TICK_MS = 60_000;
/** After a failed download, wait this long before downloading again on its own. */
const RETRY_DOWNLOAD_MS = 30 * 60_000;

export interface UpdaterDeps {
  getSettings: () => Settings;
  /** True while any task is running. */
  busy: () => boolean;
}

export class Updater extends EventEmitter {
  private status: AppUpdateStatus;
  private timers: NodeJS.Timeout[] = [];
  private downloading = false;
  private retryDownloadAt = 0;
  readonly supported = app.isPackaged && process.platform === 'win32';

  constructor(private readonly deps: UpdaterDeps) {
    super();
    const currentVersion = app.getVersion();
    this.status = this.supported
      ? { state: 'idle', currentVersion, message: 'Not checked yet' }
      : { state: 'unsupported', currentVersion, message: 'Updates are checked by the installed Windows app' };
    if (!this.supported) return;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.disableWebInstaller = true;
    autoUpdater.logger = {
      info: () => undefined,
      debug: () => undefined,
      warn: (message: unknown) => logBus.warn(`Updater: ${redact(String(message))}`),
      error: () => undefined, // reported once through the 'error' event below
    };
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking', message: 'Checking GitHub for a newer version' }));
    autoUpdater.on('update-not-available', () =>
      this.set({ state: 'up_to_date', message: 'You have the latest version', checkedAt: Date.now() }),
    );
    autoUpdater.on('update-available', (info) => {
      this.set({ state: 'available', version: info.version, message: `Version ${info.version} is available`, checkedAt: Date.now() });
      logBus.info(`Update ${info.version} is available`);
      this.tick();
    });
    autoUpdater.on('download-progress', (progress) => {
      const percent = Math.round(progress.percent);
      if (percent !== this.status.percent) this.set({ state: 'downloading', percent, message: `Downloading ${this.status.version ?? 'update'}` });
    });
    autoUpdater.on('update-downloaded', (info) => {
      this.downloading = false;
      this.set({ state: 'ready', version: info.version, percent: 100, message: `Version ${info.version} is ready. It installs when you quit the app.` });
      logBus.log({ level: 'success', message: `Update ${info.version} downloaded. It installs when you quit, or use Settings → Restart and install.` });
    });
    autoUpdater.on('error', (err: Error) => {
      if (this.downloading) this.retryDownloadAt = Date.now() + RETRY_DOWNLOAD_MS;
      this.downloading = false;
      const message = `Update check failed: ${redact(err.message).split('\n')[0]}`;
      // Keep a found version so the user can retry the download.
      this.set({ state: this.status.version ? 'available' : 'error', message });
      logBus.warn(message);
    });
  }

  get(): AppUpdateStatus {
    return this.status;
  }

  private set(patch: Partial<AppUpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  start(): void {
    if (!this.supported) return;
    this.timers.push(
      setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS),
      setInterval(() => void this.check(), CHECK_EVERY_MS),
      setInterval(() => this.tick(), TICK_MS),
    );
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  /** Starts a pending automatic download once no task is running. */
  private tick(): void {
    if (this.status.state !== 'available' || this.downloading || Date.now() < this.retryDownloadAt) return;
    if (!this.deps.getSettings().autoUpdate || this.deps.busy()) return;
    void this.download();
  }

  async check(): Promise<AppUpdateStatus> {
    if (!this.supported) return this.status;
    if (this.status.state === 'checking' || this.downloading || this.status.state === 'ready') return this.status;
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      // reported through the 'error' event
    }
    return this.status;
  }

  async download(): Promise<AppUpdateStatus> {
    if (!this.supported || this.downloading || this.status.state !== 'available') return this.status;
    this.downloading = true;
    this.set({ state: 'downloading', percent: 0, message: `Downloading ${this.status.version ?? 'update'}` });
    try {
      await autoUpdater.downloadUpdate();
    } catch {
      // reported through the 'error' event
      this.downloading = false;
      this.retryDownloadAt = Date.now() + RETRY_DOWNLOAD_MS;
    }
    return this.status;
  }

  /** Quits and installs a downloaded update silently, then reopens the app. */
  install(): { ok: boolean; message: string } {
    if (this.status.state !== 'ready') return { ok: false, message: 'No update has been downloaded yet' };
    if (this.deps.busy()) return { ok: false, message: 'Stop the running tasks first. The update also installs on its own when you quit.' };
    logBus.info(`Restarting to install ${this.status.version}`);
    autoUpdater.quitAndInstall(true, true);
    return { ok: true, message: 'Restarting to install the update' };
  }
}
