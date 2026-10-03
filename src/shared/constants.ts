import type { NotifyOn, Settings } from './types';

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
