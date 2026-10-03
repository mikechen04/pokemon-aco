// The typed contract between the UI (renderer) and the main process.
// The preload exposes exactly these channels and nothing else.
import type {
  AccountEditable,
  AccountInput,
  AccountPublic,
  ActionResult,
  BulkAccountInput,
  BulkAccountResult,
  AppInfo,
  AppUpdateStatus,
  CardInput,
  CatalogEntry,
  CatalogFile,
  CatalogImportResult,
  LogEntry,
  Profile,
  ProfileInput,
  ProxyTestResult,
  RetailerId,
  Settings,
  SettingsPatch,
  Task,
  TaskCreateRequest,
  TaskInput,
  TaskRuntime,
  TaskView,
  Toast,
} from './types';

export type PathKind = 'userData' | 'logs' | 'catalog' | 'overrides';

/** Request/response channels: `channel: (...args) => result`. */
export interface InvokeContract {
  'app:info': () => AppInfo;
  'app:openPath': (kind: PathKind) => ActionResult;
  'app:openProductUrl': (url: string) => ActionResult;

  'appUpdate:status': () => AppUpdateStatus;
  'appUpdate:check': () => AppUpdateStatus;
  'appUpdate:download': () => AppUpdateStatus;
  'appUpdate:install': () => ActionResult;

  'settings:get': () => Settings;
  'settings:update': (patch: SettingsPatch) => Settings;
  'settings:setKillSwitch': (engaged: boolean) => Settings;
  'settings:testWebhook': () => ActionResult;
  'settings:testProxies': () => ProxyTestResult[];

  'tasks:list': () => TaskView[];
  'tasks:create': (request: TaskCreateRequest) => Task[];
  'tasks:update': (id: string, input: TaskInput) => Task;
  'tasks:duplicate': (id: string) => Task;
  'tasks:remove': (ids: string[]) => ActionResult;
  'tasks:start': (ids: string[]) => ActionResult;
  'tasks:stop': (ids: string[]) => ActionResult;
  'tasks:startAll': () => ActionResult;
  'tasks:stopAll': () => ActionResult;
  'tasks:showWindow': (id: string) => ActionResult;

  'profiles:list': () => Profile[];
  'profiles:create': (input: ProfileInput) => Profile;
  'profiles:update': (id: string, input: ProfileInput) => Profile;
  'profiles:remove': (id: string) => ActionResult;
  /** Stores (encrypted) or replaces the profile's full card. Returns the profile with only a card summary. */
  'profiles:setCard': (id: string, card: CardInput) => Profile;
  'profiles:removeCard': (id: string) => Profile;

  'accounts:list': () => AccountPublic[];
  'accounts:create': (input: AccountInput) => AccountPublic;
  'accounts:bulkCreate': (input: BulkAccountInput) => BulkAccountResult;
  'accounts:update': (id: string, input: AccountInput) => AccountPublic;
  'accounts:remove': (ids: string[]) => ActionResult;
  'accounts:getEditable': (id: string) => AccountEditable;
  'accounts:openSignIn': (id: string) => ActionResult;
  'accounts:checkSession': (id: string) => AccountPublic;
  'accounts:checkAll': (retailer: RetailerId | null) => ActionResult;
  'accounts:clearSession': (id: string) => ActionResult;

  'catalog:get': () => CatalogFile;
  'catalog:upsert': (entry: CatalogEntry) => CatalogFile;
  'catalog:remove': (id: string) => CatalogFile;
  'catalog:import': (mode: 'merge' | 'replace') => CatalogImportResult;
  'catalog:export': () => ActionResult;
  'catalog:reload': () => CatalogFile;

  'logs:recent': (limit: number) => LogEntry[];
  'logs:clear': () => ActionResult;
}

/** Events pushed from main to the UI. */
export interface EventContract {
  'task:runtime': TaskRuntime;
  'tasks:changed': TaskView[];
  'log:entry': LogEntry;
  'logs:cleared': null;
  'settings:changed': Settings;
  'account:changed': AccountPublic;
  'accounts:changed': AccountPublic[];
  'profiles:changed': Profile[];
  'catalog:changed': CatalogFile;
  'appUpdate:status': AppUpdateStatus;
  toast: Toast;
}

export type InvokeChannel = keyof InvokeContract;
export type EventChannel = keyof EventContract;

// Runtime allowlists. `satisfies` makes the compiler check they match the contracts exactly.
export const INVOKE_CHANNELS = {
  'app:info': true,
  'app:openPath': true,
  'app:openProductUrl': true,
  'appUpdate:status': true,
  'appUpdate:check': true,
  'appUpdate:download': true,
  'appUpdate:install': true,
  'settings:get': true,
  'settings:update': true,
  'settings:setKillSwitch': true,
  'settings:testWebhook': true,
  'settings:testProxies': true,
  'tasks:list': true,
  'tasks:create': true,
  'tasks:update': true,
  'tasks:duplicate': true,
  'tasks:remove': true,
  'tasks:start': true,
  'tasks:stop': true,
  'tasks:startAll': true,
  'tasks:stopAll': true,
  'tasks:showWindow': true,
  'profiles:list': true,
  'profiles:create': true,
  'profiles:update': true,
  'profiles:remove': true,
  'profiles:setCard': true,
  'profiles:removeCard': true,
  'accounts:list': true,
  'accounts:create': true,
  'accounts:bulkCreate': true,
  'accounts:update': true,
  'accounts:remove': true,
  'accounts:getEditable': true,
  'accounts:openSignIn': true,
  'accounts:checkSession': true,
  'accounts:checkAll': true,
  'accounts:clearSession': true,
  'catalog:get': true,
  'catalog:upsert': true,
  'catalog:remove': true,
  'catalog:import': true,
  'catalog:export': true,
  'catalog:reload': true,
  'logs:recent': true,
  'logs:clear': true,
} as const satisfies Record<InvokeChannel, true>;

export const EVENT_CHANNELS = {
  'task:runtime': true,
  'tasks:changed': true,
  'log:entry': true,
  'logs:cleared': true,
  'settings:changed': true,
  'account:changed': true,
  'accounts:changed': true,
  'profiles:changed': true,
  'catalog:changed': true,
  'appUpdate:status': true,
  toast: true,
} as const satisfies Record<EventChannel, true>;

/** Shape of `window.aco`, exposed by the preload script. */
export interface AcoBridge {
  invoke<C extends InvokeChannel>(
    channel: C,
    ...args: Parameters<InvokeContract[C]>
  ): Promise<ReturnType<InvokeContract[C]>>;
  on<E extends EventChannel>(channel: E, listener: (payload: EventContract[E]) => void): () => void;
}

/** Errors thrown in main handlers reach the UI with this prefix stripped to the message. */
export const IPC_ERROR_PREFIX = 'ACO_ERROR:';
