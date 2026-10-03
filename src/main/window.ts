import { join } from 'node:path';
import { BrowserWindow, type NativeImage } from 'electron';

const DEV_SERVER = process.env.VITE_DEV_SERVER_URL;

/** The app's own window. It can only show the bundled UI: navigation and pop-ups are blocked. */
export function createMainWindow(icon: NativeImage): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    title: 'Pokemon ACO',
    icon,
    backgroundColor: '#0b0f17',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = DEV_SERVER ? url.startsWith(DEV_SERVER) : url.startsWith('file://');
    if (!allowed) event.preventDefault();
  });
  if (DEV_SERVER) void win.loadURL(DEV_SERVER);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
  return win;
}
