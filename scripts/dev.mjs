// Development runner: Vite dev server for the UI (hot reload), esbuild watch for
// main/preload, and an Electron process that restarts when main/preload rebuild.
import { spawn } from 'node:child_process';
import { context } from 'esbuild';
import { createServer } from 'vite';
import electronPath from 'electron';
import { mainOptions, preloadOptions } from './esbuild.config.mjs';

const server = await createServer({ configFile: 'vite.config.mts', mode: 'development' });
await server.listen();
const devUrl = server.resolvedUrls?.local[0] ?? 'http://localhost:5173/';
server.printUrls();

/** Processes we killed on purpose (restart), so their exit does not end the dev session. */
const restarting = new WeakSet();
let child = null;
let restartTimer = null;
let shuttingDown = false;

// Chromium refuses to run as root with its sandbox (common in Linux dev containers).
const electronArgs = process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox', '.'] : ['.'];

function startElectron() {
  const proc = spawn(electronPath, electronArgs, {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: devUrl },
  });
  proc.on('exit', (code) => {
    if (restarting.has(proc) || shuttingDown) return;
    void shutdown(code ?? 0);
  });
  child = proc;
}

function isRunning(proc) {
  return proc !== null && proc.exitCode === null && proc.signalCode === null;
}

function scheduleRestart() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (isRunning(child)) {
      const old = child;
      restarting.add(old);
      old.once('exit', startElectron);
      old.kill();
    } else {
      startElectron();
    }
  }, 150);
}

const restartPlugin = {
  name: 'restart-electron',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0) scheduleRestart();
    });
  },
};

const contexts = await Promise.all([
  context({ ...mainOptions(true), plugins: [restartPlugin] }),
  context({ ...preloadOptions(true), plugins: [restartPlugin] }),
]);
await Promise.all(contexts.map((ctx) => ctx.watch()));

async function shutdown(code) {
  shuttingDown = true;
  clearTimeout(restartTimer);
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
  await server.close();
  if (isRunning(child)) child.kill();
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
