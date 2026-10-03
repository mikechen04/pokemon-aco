// retailer-overrides.json lets users fix a changed endpoint, API key or page selector
// without rebuilding the app. Each retailer module declares a DEFAULTS object; values in
// this file replace matching keys (same type only).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { RetailerId } from '../../shared/types';
import { paths } from '../core/paths';

const TEMPLATE = {
  _readme:
    'Optional. Override retailer endpoints, keys or selectors when a site changes. Copy a key from the DEFAULTS object at the top of src/main/retailers/<retailer>.ts, put it under the retailer below with a new value, then stop and start your tasks. Unknown keys and values of the wrong type are ignored.',
  target: {},
  bestbuy: {},
  amazon: {},
  pokemoncenter: {},
};

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Overlay `override` onto `base`, keeping only keys that exist in base with the same type. */
export function mergeOverrides<T>(base: T, override: unknown): T {
  if (!isPlain(base) || !isPlain(override)) return base;
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (!(key in base)) continue;
    const current = (base as Plain)[key];
    if (isPlain(current)) out[key] = mergeOverrides(current, value);
    else if (Array.isArray(current) && Array.isArray(value) && value.every((v) => typeof v === typeof current[0])) out[key] = value;
    else if (typeof current === typeof value && !Array.isArray(current)) out[key] = value;
  }
  return out as T;
}

export class OverridesRepo {
  private data: Plain = {};

  constructor(private readonly onError: (message: string) => void) {
    this.reload();
  }

  reload(): void {
    const path = paths.overrides;
    try {
      if (!existsSync(path)) writeFileSync(path, JSON.stringify(TEMPLATE, null, 2) + '\n', 'utf8');
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      this.data = isPlain(parsed) ? parsed : {};
    } catch (err) {
      this.data = {};
      this.onError(`retailer-overrides.json could not be read (${err instanceof Error ? err.message : 'unknown'}); using built-in defaults.`);
    }
  }

  forRetailer<T>(id: RetailerId, defaults: T): T {
    return mergeOverrides(defaults, this.data[id]);
  }
}
