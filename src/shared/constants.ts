import type { NotifyOn, Settings } from './types';

/** Purchases older than this no longer count toward a per-account item limit. */
export const ITEM_LIMIT_WINDOW_DAYS = 30;
/** Scheduled tasks start this long before their start time, to sign in and warm up. */
export const SCHEDULE_LEAD_MS = 2 * 60_000;
/** A scheduled start missed by more than this (app closed) is not made up. */
export const SCHEDULE_GRACE_MS = 30 * 60_000;

export const LIMITS = {
  pollIntervalMs: { min: 2000, max: 600_000 },
  requestTimeoutMs: { min: 5000, max: 120_000 },
  maxConcurrency: { min: 1, max: 50 },
  maxQuantityPerTask: { min: 1, max: 10 },
  maxConsecutiveFailures: { min: 1, max: 50 },
  sessionKeepAliveMinutes: { min: 0, max: 240 },
  maxPrice: { min: 0.01, max: 100_000 },
} as const;

export const DEFAULT_NOTIFY_ON: NotifyOn = {
  inStock: true,
  queue: true,
  carted: true,
  checkedOut: true,
  paused: true,
  failed: true,
};

/** The catalog feed published by this repo's catalog-feed workflow. */
export const CATALOG_FEED_URL = 'https://raw.githubusercontent.com/mikechen04/pokemon-aco/HEAD/catalog/feed.json';

export const DEFAULT_SETTINGS: Settings = {
  pollIntervalMs: 5000,
  requestTimeoutMs: 20_000,
  maxConcurrency: 4,
  maxQuantityPerTask: 2,
  maxConsecutiveFailures: 5,
  sessionKeepAliveMinutes: 10,
  // Safe default for a shared app: walk the whole flow but stop before "Place order".
  dryRun: true,
  killSwitch: false,
  proxies: '',
  webhookUrl: '',
  desktopNotifications: true,
  notifyOn: DEFAULT_NOTIFY_ON,
  blockImagesInBackground: true,
  showAutomationWindows: false,
  bestBuyApiKey: '',
  amazonSoldByAmazonOnly: true,
  autoUpdate: true,
  // Target cancels orders past 2 of one item per guest.
  itemLimitPerAccount: { target: 2, bestbuy: 0, amazon: 0, pokemoncenter: 0 },
  anthropicApiKey: '',
  catalogFeedUrl: CATALOG_FEED_URL,
  catalogAutoSync: true,
};

export const CATALOG_CATEGORIES = [
  'Elite Trainer Box',
  'Booster Bundle',
  'Booster Box',
  'Booster Pack',
  'Collection Box',
  'Tin',
  'Pokémon Center Exclusive',
  'Other',
] as const;

export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC',
  'ND', 'OH', 'OK', 'OR', 'PA', 'PR', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
] as const;

export const DISCORD_WEBHOOK_PATTERN =
  /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,25}\/[\w-]{20,200}$/;

/** Full names, for checkout forms whose state dropdown lists names instead of codes. */
export const US_STATE_NAMES: Record<(typeof US_STATES)[number], string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', PR: 'Puerto Rico', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};
