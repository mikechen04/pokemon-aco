// UI state. Everything comes from the main process; this store only mirrors it and
// applies the live events it pushes.
import { create } from 'zustand';
import type {
  AccountPublic,
  AppInfo,
  AppUpdateStatus,
  CatalogFile,
  LogEntry,
  LogLevel,
  Profile,
  Settings,
  TaskView,
} from '../shared/types';
import { call, subscribe } from './api';

export type Tab = 'tasks' | 'profiles' | 'accounts' | 'catalog' | 'updates' | 'settings';

export interface ToastItem {
  id: number;
  level: LogLevel;
  message: string;
}

/** Opens the task form pre-filled from a catalog entry (set by the Catalog tab). */
export interface TaskDraftRequest {
  catalogEntryId?: string;
  nonce: number;
}

interface AppState {
  ready: boolean;
  loadError: string | null;
  tab: Tab;
  info: AppInfo | null;
  appUpdate: AppUpdateStatus | null;
  settings: Settings | null;
  tasks: TaskView[];
  profiles: Profile[];
  accounts: AccountPublic[];
  catalog: CatalogFile | null;
  logs: LogEntry[];
  toasts: ToastItem[];
  taskDraft: TaskDraftRequest | null;
  setTab: (tab: Tab) => void;
  toast: (level: LogLevel, message: string) => void;
  dismissToast: (id: number) => void;
  requestTaskDraft: (catalogEntryId?: string) => void;
  clearTaskDraft: () => void;
  init: () => Promise<void>;
}

const MAX_LOGS = 3000;
let toastId = 0;
let initialized = false;

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  loadError: null,
  tab: 'tasks',
  info: null,
  appUpdate: null,
  settings: null,
  tasks: [],
  profiles: [],
  accounts: [],
  catalog: null,
  logs: [],
  toasts: [],
  taskDraft: null,

  setTab: (tab) => set({ tab }),

  toast: (level, message) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, level, message }] }));
    setTimeout(() => get().dismissToast(id), level === 'error' ? 8000 : 4500);
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  requestTaskDraft: (catalogEntryId) =>
    set({ tab: 'tasks', taskDraft: { ...(catalogEntryId ? { catalogEntryId } : {}), nonce: Date.now() } }),

  clearTaskDraft: () => set({ taskDraft: null }),

  init: async () => {
    if (initialized) return;
    initialized = true;
    subscribe('task:runtime', (runtime) =>
      set((s) => ({ tasks: s.tasks.map((t) => (t.id === runtime.taskId ? { ...t, runtime } : t)) })),
    );
    subscribe('tasks:changed', (tasks) => set({ tasks }));
    subscribe('profiles:changed', (profiles) => set({ profiles }));
    subscribe('accounts:changed', (accounts) => set({ accounts }));
    subscribe('account:changed', (account) =>
      set((s) => ({ accounts: s.accounts.map((a) => (a.id === account.id ? account : a)) })),
    );
    subscribe('settings:changed', (settings) => set({ settings }));
    subscribe('catalog:changed', (catalog) => set({ catalog }));
    subscribe('appUpdate:status', (appUpdate) => set({ appUpdate }));
    subscribe('log:entry', (entry) => set((s) => ({ logs: [...s.logs, entry].slice(-MAX_LOGS) })));
    subscribe('logs:cleared', () => set({ logs: [] }));
    try {
      const [info, appUpdate, settings, tasks, profiles, accounts, catalog, logs] = await Promise.all([
        call('app:info'),
        call('appUpdate:status'),
        call('settings:get'),
        call('tasks:list'),
        call('profiles:list'),
        call('accounts:list'),
        call('catalog:get'),
        call('logs:recent', MAX_LOGS),
      ]);
      set({ info, appUpdate, settings, tasks, profiles, accounts, catalog, logs, ready: true });
    } catch (err) {
      set({ loadError: err instanceof Error ? err.message : String(err) });
    }
  },
}));

/** Runs an action and reports failures (and optionally success) as toasts. */
export async function act<T>(work: Promise<T>, success?: string | ((value: T) => string)): Promise<T | undefined> {
  const { toast } = useApp.getState();
  try {
    const value = await work;
    if (success) toast('success', typeof success === 'function' ? success(value) : success);
    return value;
  } catch (err) {
    toast('error', err instanceof Error ? err.message : String(err));
    return undefined;
  }
}
