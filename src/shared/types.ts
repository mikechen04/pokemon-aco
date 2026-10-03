// Domain types shared by the main process and the UI.

export const RETAILER_IDS = ['target', 'bestbuy', 'amazon', 'pokemoncenter'] as const;
export type RetailerId = (typeof RETAILER_IDS)[number];

export const TASK_STATES = [
  'idle',
  'monitoring',
  'in_stock',
  'queued',
  'carted',
  'checking_out',
  'checked_out',
  'paused',
  'failed',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export type TaskMode = 'url' | 'keyword';

export interface Task {
  id: string;
  createdAt: number;
  retailer: RetailerId;
  mode: TaskMode;
  /** Product URL / SKU (url mode) or keyword expression (keyword mode). */
  input: string;
  /** TCIN, SKU, ASIN or Pokemon Center product id, parsed from `input` in url mode. */
  productId?: string;
  catalogEntryId?: string;
  label?: string;
  profileId: string;
  accountId: string;
  quantity: number;
  /** Highest acceptable price per item in USD, before tax and shipping. */
  maxPrice: number;
  /** Tasks created together across several accounts share a group. */
  groupId?: string;
  groupName?: string;
  /** Stop the whole group once this many orders are placed. */
  groupGoal?: number;
  lastResult?: TaskResult;
}

export interface TaskResult {
  state: 'checked_out' | 'failed';
  message: string;
  at: number;
  orderNumber?: string;
}

export type TaskInput = Pick<
  Task,
  'retailer' | 'mode' | 'input' | 'catalogEntryId' | 'label' | 'profileId' | 'accountId' | 'quantity' | 'maxPrice'
>;

/** New task(s): one per selected account (times `copies`), grouped when there is more than one. */
export interface TaskCreateRequest {
  input: TaskInput;
  accountIds: string[];
  /** Use each account's default profile when it has one (falls back to input.profileId). */
  useAccountProfiles: boolean;
  copies: number;
  groupName: string;
  /** Stop the group after this many placed orders; null = no group limit. */
  groupGoal: number | null;
}

/** Live, in-memory status of a task. Not persisted except for terminal results. */
export interface TaskRuntime {
  taskId: string;
  state: TaskState;
  message: string;
  running: boolean;
  updatedAt: number;
  productTitle?: string;
  productUrl?: string;
  imageUrl?: string;
  lastPrice?: number;
  failures: number;
  orderNumber?: string;
  /** A session window is available for the user to look at or finish a step by hand. */
  handoff: boolean;
}

export interface TaskView extends Task {
  runtime: TaskRuntime;
}

export interface Address {
  firstName: string;
  lastName: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
}

export type CardBrand = 'visa' | 'mastercard' | 'amex' | 'discover' | 'other';

/** What the UI may see about a stored card. The number and security code stay in the main process. */
export interface CardSummary {
  brand: CardBrand;
  last4: string;
  expMonth: number;
  expYear: number;
  holder: string;
  updatedAt: number;
}

/** A full card typed in the Profiles tab. Sent once to the main process, which encrypts it. */
export interface CardInput {
  holder: string;
  number: string;
  expMonth: number;
  expYear: number;
  cvv: string;
}

export interface Profile {
  id: string;
  createdAt: number;
  name: string;
  shipping: Address;
  billingSameAsShipping: boolean;
  billing: Address;
  /** Last 4 digits of the card to pay with: one saved on the retailer account, or the stored card. */
  cardLast4: string;
  cardLabel: string;
  /** Optional full card (e.g. a virtual card) typed into checkout when the account has no saved card. */
  card: CardSummary | null;
}

export type ProfileInput = Omit<Profile, 'id' | 'createdAt' | 'card'>;

export type AccountSessionState = 'unknown' | 'checking' | 'signed_in' | 'signed_out' | 'needs_attention';

/** What the UI is allowed to see about an account. Passwords never leave the main process. */
export interface AccountPublic {
  id: string;
  createdAt: number;
  retailer: RetailerId;
  label: string;
  emailMasked: string;
  hasPassword: boolean;
  hasTwoFactorNote: boolean;
  /** Default checkout profile for this account (its saved card and address). */
  profileId?: string;
  session: AccountSessionState;
  sessionMessage: string;
  sessionCheckedAt?: number;
}

export interface AccountInput {
  retailer: RetailerId;
  label: string;
  email: string;
  /** Empty or omitted on update keeps the stored password. */
  password?: string;
  twoFactorNote?: string;
  profileId?: string;
}

/** Bulk add: one account per line, "email:password" (also "," or tab as separator). */
export interface BulkAccountInput {
  retailer: RetailerId;
  text: string;
  profileId?: string;
  labelPrefix?: string;
}

export interface BulkAccountResult {
  created: number;
  skipped: number;
  errors: string[];
}

export interface AccountEditable {
  id: string;
  retailer: RetailerId;
  label: string;
  email: string;
  twoFactorNote: string;
  hasPassword: boolean;
  profileId: string;
}

export interface NotifyOn {
  inStock: boolean;
  queue: boolean;
  carted: boolean;
  checkedOut: boolean;
  paused: boolean;
  failed: boolean;
}

export interface Settings {
  pollIntervalMs: number;
  requestTimeoutMs: number;
  maxConcurrency: number;
  maxQuantityPerTask: number;
  maxConsecutiveFailures: number;
  sessionKeepAliveMinutes: number;
  dryRun: boolean;
  killSwitch: boolean;
  /** One HTTP proxy per line. */
  proxies: string;
  webhookUrl: string;
  desktopNotifications: boolean;
  notifyOn: NotifyOn;
  blockImagesInBackground: boolean;
  showAutomationWindows: boolean;
  bestBuyApiKey: string;
  amazonSoldByAmazonOnly: boolean;
  /** Download new versions from GitHub Releases on their own (installed when the app quits). */
  autoUpdate: boolean;
}

export type SettingsPatch = Partial<Omit<Settings, 'notifyOn'>> & { notifyOn?: Partial<NotifyOn> };

export interface CatalogRetailerRef {
  url: string;
  sku: string;
}

export interface CatalogEntry {
  id: string;
  name: string;
  category: string;
  set: string;
  tags: string[];
  imageUrl: string;
  msrp: number | null;
  notes: string;
  retailers: Record<RetailerId, CatalogRetailerRef>;
}

export interface CatalogFile {
  version: 1;
  updatedAt: string;
  entries: CatalogEntry[];
}

export type LogLevel = 'info' | 'success' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  ts: number;
  level: LogLevel;
  taskId?: string;
  retailer?: RetailerId;
  state?: TaskState;
  message: string;
}

export interface AppInfo {
  version: string;
  platform: string;
  encryption: { available: boolean; backend: string; strong: boolean };
  paths: { userData: string; logs: string; catalog: string; overrides: string };
}

export type AppUpdateState = 'unsupported' | 'idle' | 'checking' | 'up_to_date' | 'available' | 'downloading' | 'ready' | 'error';

export interface AppUpdateStatus {
  state: AppUpdateState;
  currentVersion: string;
  /** The newer version found on GitHub Releases. */
  version?: string;
  /** Download progress, 0-100. */
  percent?: number;
  message: string;
  checkedAt?: number;
}

export interface ProxyTestResult {
  proxy: string;
  ok: boolean;
  ms: number;
  detail: string;
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

export interface CatalogImportResult {
  ok: boolean;
  message: string;
  added: number;
  updated: number;
  total: number;
}

export interface Toast {
  level: LogLevel;
  message: string;
}
