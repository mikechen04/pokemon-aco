import { EventEmitter } from 'node:events';
import { DEFAULT_SETTINGS, LIMITS } from '../../shared/constants';
import { parseProxyList } from '../../shared/proxies';
import type { Settings, SettingsPatch } from '../../shared/types';
import { JsonStore } from '../core/fileStore';
import { paths } from '../core/paths';
import { forgetSecret, registerSecret } from '../core/redact';

type NumericKey = keyof typeof LIMITS & keyof Settings;

function clampInt(value: unknown, fallback: number, range: { min: number; max: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

/** Merge whatever is on disk with the defaults so older or hand-edited files still load. */
function normalizeSettings(raw: unknown): Settings {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Settings = structuredClone(DEFAULT_SETTINGS);
  const numeric: NumericKey[] = [
    'pollIntervalMs',
    'requestTimeoutMs',
    'maxConcurrency',
    'maxQuantityPerTask',
    'maxConsecutiveFailures',
    'sessionKeepAliveMinutes',
  ];
  for (const key of numeric) out[key] = clampInt(source[key], DEFAULT_SETTINGS[key], LIMITS[key]);
  const booleans = [
    'dryRun',
    'killSwitch',
    'desktopNotifications',
    'blockImagesInBackground',
    'showAutomationWindows',
    'amazonSoldByAmazonOnly',
  ] as const;
  for (const key of booleans) if (typeof source[key] === 'boolean') out[key] = source[key];
  const strings = ['proxies', 'webhookUrl', 'bestBuyApiKey'] as const;
  for (const key of strings) if (typeof source[key] === 'string') out[key] = source[key];
  const notify = (source.notifyOn ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(out.notifyOn) as Array<keyof Settings['notifyOn']>) {
    if (typeof notify[key] === 'boolean') out.notifyOn[key] = notify[key];
  }
  return out;
}

function secretsOf(settings: Settings): string[] {
  const values = [settings.webhookUrl, settings.bestBuyApiKey];
  for (const proxy of parseProxyList(settings.proxies).proxies) {
    if (proxy.password) values.push(proxy.password);
    if (proxy.username) values.push(`${proxy.username}:${proxy.password ?? ''}`);
  }
  // The token part of the webhook URL on its own is also secret.
  const token = /\/webhooks\/\d+\/([\w-]+)/.exec(settings.webhookUrl)?.[1];
  if (token) values.push(token);
  return values.filter(Boolean);
}

export class SettingsRepo extends EventEmitter {
  private readonly store: JsonStore<Settings>;

  constructor(onError: (message: string) => void) {
    super();
    this.store = new JsonStore<Settings>({
      path: paths.dataFile('settings.json'),
      defaults: () => structuredClone(DEFAULT_SETTINGS),
      encrypt: true,
      normalize: normalizeSettings,
      onError,
    });
    for (const secret of secretsOf(this.store.get())) registerSecret(secret);
  }

  get(): Settings {
    return this.store.get();
  }

  /** `patch` must already be validated by settingsPatchSchema. */
  update(patch: SettingsPatch): Settings {
    const current = this.store.get();
    const next: Settings = {
      ...current,
      ...patch,
      notifyOn: { ...current.notifyOn, ...(patch.notifyOn ?? {}) },
    };
    for (const secret of secretsOf(current)) forgetSecret(secret);
    for (const secret of secretsOf(next)) registerSecret(secret);
    this.store.set(next);
    this.emit('changed', next);
    return next;
  }

  flush(): void {
    this.store.flushSync();
  }
}
