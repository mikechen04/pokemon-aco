// Every request from the UI lands here. Inputs are validated with zod, errors are redacted,
// and only the app's own window may call these handlers.
import { randomUUID } from 'node:crypto';
import { app, dialog, ipcMain, net, session, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type { z } from 'zod';
import { IPC_ERROR_PREFIX, type InvokeChannel, type InvokeContract, type PathKind } from '../shared/ipc';
import { describeProxy, parseProxyList, proxyRules } from '../shared/proxies';
import { isRetailerUrl, parseProductInput, RETAILERS } from '../shared/retailers';
import {
  accountInputSchema,
  bulkAccountSchema,
  catalogEntrySchema,
  firstIssue,
  profileInputSchema,
  retailerIdSchema,
  settingsPatchSchema,
  taskCreateSchema,
  taskInputSchema,
} from '../shared/schemas';
import type { EventChannel, EventContract } from '../shared/ipc';
import type { Profile, ProfileInput, ProxyTestResult, Settings, Task, TaskInput } from '../shared/types';
import { logBus } from './core/logger';
import type { Notifier } from './core/notifier';
import { paths } from './core/paths';
import { redact } from './core/redact';
import { encryptionStatus } from './core/secrets';
import type { AccountsRepo } from './data/accounts';
import type { CatalogRepo } from './data/catalog';
import type { Collection } from './data/collection';
import type { OverridesRepo } from './data/overrides';
import type { SettingsRepo } from './data/settings';
import type { AccountWindows } from './engine/accountWindow';
import type { SessionKeeper } from './engine/keepalive';
import type { TaskManager } from './engine/manager';
import type { SessionManager } from './engine/sessions';

export interface AppServices {
  mainWindow: () => BrowserWindow | null;
  settings: SettingsRepo;
  tasks: Collection<Task>;
  profiles: Collection<Profile>;
  accounts: AccountsRepo;
  catalog: CatalogRepo;
  overrides: OverridesRepo;
  manager: TaskManager;
  sessions: SessionManager;
  keeper: SessionKeeper;
  accountWindows: AccountWindows;
  notifier: Notifier;
}

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(firstIssue(result.error));
  return result.data;
}

function normalizeProfileInput(input: ProfileInput): ProfileInput {
  return { ...input, billing: input.billingSameAsShipping ? { ...input.shipping } : input.billing };
}

export function registerIpc(services: AppServices): void {
  const { settings, tasks, profiles, accounts, catalog, overrides, manager, sessions, keeper, accountWindows, notifier } = services;

  const trusted = (event: IpcMainInvokeEvent) => {
    const win = services.mainWindow();
    return Boolean(win && !win.isDestroyed() && event.sender === win.webContents);
  };

  function handle<C extends InvokeChannel>(
    channel: C,
    fn: (...args: Parameters<InvokeContract[C]>) => ReturnType<InvokeContract[C]> | Promise<ReturnType<InvokeContract[C]>>,
  ): void {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!trusted(event)) throw new Error(`${IPC_ERROR_PREFIX}Request from an unknown window was blocked`);
      try {
        return await fn(...(args as Parameters<InvokeContract[C]>));
      } catch (err) {
        throw new Error(IPC_ERROR_PREFIX + redact(err instanceof Error ? err.message : 'Unexpected error'));
      }
    });
  }

  // ---- app ----
  handle('app:info', () => {
    const encryption = encryptionStatus();
    return {
      version: app.getVersion(),
      platform: process.platform,
      encryption,
      paths: { userData: paths.userData, logs: paths.logs, catalog: paths.catalog, overrides: paths.overrides },
    };
  });

  handle('app:openPath', async (kind: PathKind) => {
    const target = { userData: paths.userData, logs: paths.logs, catalog: paths.catalog, overrides: paths.overrides }[kind];
    if (!target) throw new Error('Unknown location');
    if (kind === 'overrides') overrides.reload();
    const error = await shell.openPath(target);
    return error ? { ok: false, message: error } : { ok: true, message: 'Opened' };
  });

  handle('app:openProductUrl', async (url: string) => {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url) || !isRetailerUrl(url)) throw new Error('Only retailer product links can be opened');
    await shell.openExternal(url);
    return { ok: true, message: 'Opened in your browser' };
  });

  // ---- settings ----
  const applySettings = (patch: unknown): Settings => {
    const valid = validate(settingsPatchSchema, patch);
    const previous = settings.get();
    const next = settings.update(valid);
    manager.onSettingsChanged(previous, next);
    void sessions.onSettingsChanged(next);
    if (previous.killSwitch !== next.killSwitch) logBus.log({ level: next.killSwitch ? 'warn' : 'info', message: next.killSwitch ? 'Kill switch engaged' : 'Kill switch released' });
    if (previous.dryRun !== next.dryRun) logBus.log({ level: 'warn', message: next.dryRun ? 'Dry run turned ON: orders will not be placed' : 'Dry run turned OFF: tasks will place real orders' });
    return next;
  };

  handle('settings:get', () => settings.get());
  handle('settings:update', (patch) => applySettings(patch));
  handle('settings:setKillSwitch', (engaged) => applySettings({ killSwitch: Boolean(engaged) }));
  handle('settings:testWebhook', () => notifier.test());
  handle('settings:testProxies', async () => {
    const { proxies } = parseProxyList(settings.get().proxies);
    const results: ProxyTestResult[] = [];
    for (const [index, proxy] of proxies.slice(0, 25).entries()) {
      // In-memory sessions, one per list position, reused between tests.
      const ses = session.fromPartition(`proxytest-${index}`);
      await ses.setProxy({ proxyRules: proxyRules(proxy) });
      await ses.closeAllConnections();
      const started = Date.now();
      const outcome = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
        const request = net.request({ url: 'https://www.gstatic.com/generate_204', session: ses });
        const timer = setTimeout(() => {
          request.abort();
          resolve({ ok: false, detail: 'Timed out after 10s' });
        }, 10_000);
        request.on('login', (authInfo, callback) => {
          if (authInfo.isProxy && proxy.username) callback(proxy.username, proxy.password ?? '');
          else callback();
        });
        request.on('response', (response) => {
          clearTimeout(timer);
          response.on('data', () => undefined);
          response.on('end', () => undefined);
          resolve(response.statusCode < 400 ? { ok: true, detail: `HTTP ${response.statusCode}` } : { ok: false, detail: `HTTP ${response.statusCode}` });
        });
        request.on('error', (err) => {
          clearTimeout(timer);
          resolve({ ok: false, detail: redact(err.message) });
        });
        request.end();
      });
      results.push({ proxy: describeProxy(proxy), ms: Date.now() - started, ...outcome });
    }
    return results;
  });

  // ---- tasks ----
  const parsedProduct = (input: TaskInput) => {
    if (input.mode !== 'url') return {};
    const parsed = parseProductInput(input.retailer, input.input);
    if (!parsed.ok) throw new Error(parsed.error);
    return { productId: parsed.product.productId };
  };

  const checkTaskRefs = (input: TaskInput, accountId: string, profileId: string) => {
    const account = accounts.get(accountId);
    if (!account) throw new Error('One of the selected accounts no longer exists');
    if (account.retailer !== input.retailer) throw new Error(`Account "${account.label}" is for ${RETAILERS[account.retailer].name}`);
    if (!profiles.get(profileId)) throw new Error('Pick a profile');
    const max = settings.get().maxQuantityPerTask;
    if (input.quantity > max) throw new Error(`Quantity is above the global max of ${max} (change it in Settings)`);
  };

  handle('tasks:list', () => manager.list());

  handle('tasks:create', (request) => {
    const valid = validate(taskCreateSchema, request);
    const input = valid.input;
    const accountIds = [...new Set(valid.accountIds)];
    const product = parsedProduct(input);
    const plans = accountIds.flatMap((accountId) => {
      const account = accounts.get(accountId);
      const preferred = valid.useAccountProfiles && account?.profileId && profiles.get(account.profileId) ? account.profileId : input.profileId;
      checkTaskRefs(input, accountId, preferred);
      return Array.from({ length: valid.copies }, () => ({ accountId, profileId: preferred }));
    });
    if (plans.length > 500) throw new Error('That would create more than 500 tasks at once');
    const grouped = plans.length > 1;
    const groupId = grouped ? randomUUID() : undefined;
    const groupName = valid.groupName || input.label || (input.mode === 'keyword' ? input.input : `${RETAILERS[input.retailer].name} ${product.productId ?? ''}`.trim());
    const created: Task[] = plans.map((plan) => ({
      id: randomUUID(),
      createdAt: Date.now(),
      retailer: input.retailer,
      mode: input.mode,
      input: input.input.trim(),
      ...product,
      ...(input.catalogEntryId ? { catalogEntryId: input.catalogEntryId } : {}),
      ...(input.label ? { label: input.label } : {}),
      profileId: plan.profileId,
      accountId: plan.accountId,
      quantity: input.quantity,
      maxPrice: input.maxPrice,
      ...(groupId ? { groupId, groupName } : {}),
      ...(groupId && valid.groupGoal ? { groupGoal: valid.groupGoal } : {}),
    }));
    for (const task of created) tasks.insert(task);
    logBus.info(`Created ${created.length} task(s)${grouped ? ` in group "${groupName}" across ${accountIds.length} account(s)` : ''}`);
    return created;
  });

  handle('tasks:update', (id, input) => {
    const valid = validate(taskInputSchema, input);
    const existing = tasks.get(id);
    if (!existing) throw new Error('Task not found');
    if (manager.isRunning(id)) throw new Error('Stop the task before editing it');
    checkTaskRefs(valid, valid.accountId, valid.profileId);
    const { productId: _old, catalogEntryId: _c, label: _l, ...rest } = existing;
    const next: Task = {
      ...rest,
      retailer: valid.retailer,
      mode: valid.mode,
      input: valid.input.trim(),
      ...parsedProduct(valid),
      ...(valid.catalogEntryId ? { catalogEntryId: valid.catalogEntryId } : {}),
      ...(valid.label ? { label: valid.label } : {}),
      profileId: valid.profileId,
      accountId: valid.accountId,
      quantity: valid.quantity,
      maxPrice: valid.maxPrice,
    };
    return tasks.replace(next);
  });

  handle('tasks:duplicate', (id) => {
    const existing = tasks.get(id);
    if (!existing) throw new Error('Task not found');
    const { lastResult: _r, ...rest } = existing;
    return tasks.insert({ ...rest, id: randomUUID(), createdAt: Date.now() });
  });

  handle('tasks:remove', async (ids) => {
    await manager.remove(ids);
    return { ok: true, message: `Deleted ${ids.length} task(s)` };
  });
  handle('tasks:start', (ids) => manager.start(ids));
  handle('tasks:stop', async (ids) => {
    await manager.stop(ids);
    return { ok: true, message: 'Stopped' };
  });
  handle('tasks:startAll', () => manager.startAll());
  handle('tasks:stopAll', async () => {
    await manager.stopAll();
    return { ok: true, message: 'Stopped all tasks' };
  });
  handle('tasks:showWindow', (id) => manager.showWindow(id));

  // ---- profiles ----
  handle('profiles:list', () => profiles.list());
  handle('profiles:create', (input) => {
    const valid = normalizeProfileInput(validate(profileInputSchema, input) as ProfileInput);
    return profiles.insert({ ...valid, id: randomUUID(), createdAt: Date.now() });
  });
  handle('profiles:update', (id, input) => {
    const existing = profiles.get(id);
    if (!existing) throw new Error('Profile not found');
    const valid = normalizeProfileInput(validate(profileInputSchema, input) as ProfileInput);
    return profiles.replace({ ...valid, id, createdAt: existing.createdAt });
  });
  handle('profiles:remove', (id) => {
    const users = tasks.list().filter((t) => t.profileId === id).length;
    if (users > 0) throw new Error(`This profile is used by ${users} task(s). Change or delete those tasks first.`);
    profiles.remove([id]);
    accounts.forgetProfile(id);
    return { ok: true, message: 'Profile deleted' };
  });

  // ---- accounts ----
  const checkProfileRef = (profileId: string | undefined) => {
    if (profileId && !profiles.get(profileId)) throw new Error('The selected default profile no longer exists');
  };

  handle('accounts:list', () => accounts.list());
  handle('accounts:create', (input) => {
    const valid = validate(accountInputSchema, input);
    checkProfileRef(valid.profileId);
    return accounts.create(valid);
  });
  handle('accounts:bulkCreate', (input) => {
    const valid = validate(bulkAccountSchema, input);
    checkProfileRef(valid.profileId);
    const result = accounts.createMany(valid);
    logBus.info(`Bulk add: ${result.created} ${RETAILERS[valid.retailer].name} account(s) added, ${result.skipped} skipped`);
    return result;
  });
  handle('accounts:update', (id, input) => {
    const valid = validate(accountInputSchema, input);
    checkProfileRef(valid.profileId);
    return accounts.update(id, valid);
  });
  handle('accounts:remove', async (ids) => {
    const set = new Set(ids);
    await manager.stop(tasks.list().filter((t) => set.has(t.accountId)).map((t) => t.id));
    for (const id of ids) {
      accountWindows.close(id);
      await sessions.clearAccount(id).catch(() => undefined);
    }
    const removed = accounts.remove(ids);
    return { ok: true, message: `Deleted ${removed} account(s) and their saved sessions` };
  });
  handle('accounts:getEditable', (id) => accounts.editable(id));
  handle('accounts:openSignIn', (id) => accountWindows.open(id));
  handle('accounts:checkSession', async (id) => {
    await keeper.check(id);
    const view = accounts.publicView(id);
    if (!view) throw new Error('Account not found');
    return view;
  });
  handle('accounts:checkAll', (retailer) => {
    const filter = retailer === null ? null : validate(retailerIdSchema, retailer);
    const ids = accounts
      .list()
      .filter((a) => filter === null || a.retailer === filter)
      .map((a) => a.id);
    // Three at a time in the background so a long list does not hammer a retailer.
    void (async () => {
      const queue = [...ids];
      const worker = async () => {
        for (let id = queue.shift(); id; id = queue.shift()) await keeper.check(id);
      };
      await Promise.all([worker(), worker(), worker()]);
    })();
    return { ok: true, message: `Checking ${ids.length} account session(s)` };
  });
  handle('accounts:clearSession', async (id) => {
    await manager.stop(tasks.list().filter((t) => t.accountId === id).map((t) => t.id));
    accountWindows.close(id);
    await sessions.clearAccount(id);
    accounts.setSession(id, 'signed_out', 'Session cleared');
    return { ok: true, message: 'Saved session cleared for this account' };
  });

  // ---- catalog ----
  handle('catalog:get', () => catalog.get());
  handle('catalog:upsert', (entry) => catalog.upsert(validate(catalogEntrySchema, entry)));
  handle('catalog:remove', (id) => catalog.remove(id));
  handle('catalog:reload', () => catalog.reload());
  handle('catalog:import', async (mode) => {
    const win = services.mainWindow();
    const options = { title: 'Import catalog JSON', properties: ['openFile' as const], filters: [{ name: 'JSON', extensions: ['json'] }] };
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const file = picked.filePaths[0];
    if (picked.canceled || !file) return { ok: false, message: 'Import cancelled', added: 0, updated: 0, total: catalog.get().entries.length };
    return catalog.importFrom(file, mode === 'replace' ? 'replace' : 'merge');
  });
  handle('catalog:export', async () => {
    const win = services.mainWindow();
    const options = { title: 'Export catalog', defaultPath: 'pokemon-aco-catalog.json', filters: [{ name: 'JSON', extensions: ['json'] }] };
    const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return { ok: false, message: 'Export cancelled' };
    await catalog.exportTo(picked.filePath);
    return { ok: true, message: `Exported ${catalog.get().entries.length} entries` };
  });

  // ---- logs ----
  handle('logs:recent', (limit) => logBus.recent(typeof limit === 'number' ? limit : 1000));
  handle('logs:clear', () => {
    logBus.clear();
    return { ok: true, message: 'Log cleared' };
  });
}

/** Pushes main-process events to the UI. Runtime updates are batched per task (latest wins). */
export function wireEvents(services: AppServices): void {
  const send = <E extends EventChannel>(channel: E, payload: EventContract[E]) => {
    const win = services.mainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  const pendingRuntime = new Map<string, EventContract['task:runtime']>();
  let flushTimer: NodeJS.Timeout | null = null;
  services.manager.on('runtime', (runtime: EventContract['task:runtime']) => {
    pendingRuntime.set(runtime.taskId, runtime);
    flushTimer ??= setTimeout(() => {
      flushTimer = null;
      for (const value of pendingRuntime.values()) send('task:runtime', value);
      pendingRuntime.clear();
    }, 80);
  });
  services.tasks.on('changed', () => send('tasks:changed', services.manager.list()));
  services.profiles.on('changed', (list: Profile[]) => send('profiles:changed', list));
  services.accounts.on('changed', (list: EventContract['accounts:changed']) => send('accounts:changed', list));
  services.accounts.on('account', (account: EventContract['account:changed']) => send('account:changed', account));
  services.settings.on('changed', (value: Settings) => send('settings:changed', value));
  services.catalog.on('changed', (file: EventContract['catalog:changed']) => send('catalog:changed', file));
  logBus.on('entry', (entry: EventContract['log:entry']) => send('log:entry', entry));
  logBus.on('cleared', () => send('logs:cleared', null));
}
