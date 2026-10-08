// Domain types shared by the main process and the UI.

export const RETAILER_IDS = ['target', 'bestbuy', 'amazon', 'pokemoncenter'] as const;
export type RetailerId = (typeof RETAILER_IDS)[number];

export const TASK_STATES = [
  'scheduled',
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
  /** Starts on its own at this time (epoch ms); cleared once it has started. */
  startAt?: number;
  /** Stops on its own at this time (epoch ms). */
  stopAt?: number;
  /** Keep buying: place up to this many orders (1 = buy once). */
  maxOrders?: number;
  /** Never let this task's orders add up to more than this (USD, tax included when the store shows it). */
  budget?: number;
  /** Orders and spending of the current run. */
  progress?: TaskProgress;
  /** Where the task came from, e.g. a pasted drop announcement. */
  source?: string;
  lastResult?: TaskResult;
}

export interface TaskProgress {
  orders: number;
  /** Units bought across those orders. */
  units: number;
  /** USD; orders whose total could not be read count as 0. */
  spent: number;
}

export interface TaskResult {
  state: 'checked_out' | 'failed';
  message: string;
  at: number;
  orderNumber?: string;
}

export type TaskInput = Pick<
  Task,
  | 'retailer'
  | 'mode'
  | 'input'
  | 'catalogEntryId'
  | 'label'
  | 'profileId'
  | 'accountId'
  | 'quantity'
  | 'maxPrice'
  | 'startAt'
  | 'stopAt'
  | 'maxOrders'
  | 'budget'
  | 'source'
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
  /** Most units of one item an account may buy per store (30 days, 0 = no limit), e.g. Target's 2. */
  itemLimitPerAccount: Record<RetailerId, number>;
  /** Anthropic API key for reading pasted drop announcements. Never shown in full or logged. */
  anthropicApiKey: string;
  /** Where the catalog feed (catalog/feed.json) is downloaded from. */
  catalogFeedUrl: string;
  /** Sync the catalog from the feed at start and every few hours. */
  catalogAutoSync: boolean;
}

export type SettingsPatch = Partial<Omit<Settings, 'notifyOn' | 'itemLimitPerAccount'>> & {
  notifyOn?: Partial<NotifyOn>;
  itemLimitPerAccount?: Partial<Record<RetailerId, number>>;
};

export interface CatalogRetailerRef {
  url: string;
  sku: string;
}

/** Resale market data for a catalog entry (TCGplayer, via the catalog feed). */
export interface CatalogMarket {
  /** TCGplayer market price (what it has recently sold for), USD. */
  price: number | null;
  /** Lowest current listing, USD. */
  low: number | null;
  /** Market price change over 7 and 30 days, as a fraction (0.12 = +12%). */
  change7d: number | null;
  change30d: number | null;
  /** Date of the prices, YYYY-MM-DD. */
  updatedAt: string;
}

export interface CatalogEntry {
  id: string;
  name: string;
  category: string;
  set: string;
  tags: string[];
  imageUrl: string;
  msrp: number | null;
  /** True when `msrp` is the usual retail price for this kind of product rather than a confirmed one. */
  msrpEstimated: boolean;
  notes: string;
  /** YYYY-MM-DD, or '' when unknown. */
  releaseDate: string;
  tcgplayerId: number | null;
  tcgplayerUrl: string;
  market: CatalogMarket | null;
  /** Feed ranking: higher means a bigger resale margin and a rising price. */
  score: number | null;
  retailers: Record<RetailerId, CatalogRetailerRef>;
  /** 'feed' entries are added and kept current by catalog sync; 'user' entries are yours. */
  origin: 'user' | 'feed';
  /** What the feed last said for the editable fields, so sync can tell your edits apart. */
  feedBase?: CatalogFeedBase;
}

export type CatalogFeedBase = Pick<CatalogEntry, 'name' | 'category' | 'set' | 'tags' | 'imageUrl' | 'msrp' | 'msrpEstimated' | 'notes' | 'retailers'>;

export interface CatalogFeedState {
  url: string;
  /** When this app last synced, and when the feed itself was generated (ISO). */
  syncedAt: string;
  generatedAt: string;
  source: string;
}

export interface CatalogFile {
  version: 1;
  updatedAt: string;
  feed?: CatalogFeedState;
  /** Feed entries the user deleted; sync does not bring them back. */
  dismissed: string[];
  entries: CatalogEntry[];
}

/** catalog/feed.json, regenerated daily by the catalog-feed workflow. */
export interface CatalogFeed {
  version: 1;
  generatedAt: string;
  source: string;
  entries: Array<Omit<CatalogEntry, 'origin' | 'feedBase'>>;
}

export interface CatalogSyncResult {
  ok: boolean;
  message: string;
  added: number;
  updated: number;
  removed: number;
  total: number;
}

export const DROP_SALE_TYPES = ['online_sale', 'draw_or_raffle', 'in_store_only', 'queue', 'unknown'] as const;
export type DropSaleType = (typeof DROP_SALE_TYPES)[number];

/** One product release Claude found in a pasted announcement, checked against what the app supports. */
export interface DropProposal {
  id: string;
  productName: string;
  /** The store as announced, e.g. "Walmart". */
  storeName: string;
  /** The supported store it is sold at, or null (Walmart, GameStop, ...). */
  retailer: RetailerId | null;
  saleType: DropSaleType;
  /** When sales open (epoch ms), or null when the post gives no usable time. */
  startsAt: number | null;
  /** The time as the post wrote it, e.g. "tomorrow at 9 AM PDT". */
  timeText: string;
  /** A product link that parses for `retailer`, or '' when there is none yet. */
  url: string;
  catalogEntryId: string | null;
  /** Retail price: the catalog's, else the one in the post. */
  msrp: number | null;
  /** Why the app can't make a buying task for it, or null when it can. */
  blocker: string | null;
  /** Supported stores the catalog has a link for, besides `retailer`. */
  alternatives: { retailer: RetailerId; url: string }[];
  notes: string;
}

export interface DropAnalysis {
  summary: string;
  drops: DropProposal[];
  warnings: string[];
  /** The model that answered (a fallback model when the first one declined). */
  model: string;
  inputTokens: number;
  outputTokens: number;
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
