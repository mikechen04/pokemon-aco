// Retailer metadata and product URL/SKU parsing. Pure functions: used by the UI for
// instant feedback, by the main process for validation, and by unit tests.
import { RETAILER_IDS, type RetailerId } from './types';

export interface RetailerMeta {
  id: RetailerId;
  name: string;
  /** Badge color in the UI. */
  color: string;
  hosts: string[];
  productIdLabel: string;
  inputHint: string;
  /** Whether the retailer is known to put drops behind a waiting-room queue. */
  usesQueue: boolean;
}

export const RETAILERS: Record<RetailerId, RetailerMeta> = {
  target: {
    id: 'target',
    name: 'Target',
    color: '#ff8a8a',
    hosts: ['target.com'],
    productIdLabel: 'TCIN',
    inputHint: 'https://www.target.com/p/.../-/A-12345678 or an 8-digit TCIN',
    usesQueue: false,
  },
  bestbuy: {
    id: 'bestbuy',
    name: 'Best Buy',
    color: '#ffd166',
    hosts: ['bestbuy.com'],
    productIdLabel: 'SKU',
    inputHint: 'https://www.bestbuy.com/site/...?skuId=1234567 or a 7-digit SKU',
    usesQueue: false,
  },
  amazon: {
    id: 'amazon',
    name: 'Amazon',
    color: '#ffb067',
    hosts: ['amazon.com'],
    productIdLabel: 'ASIN',
    inputHint: 'https://www.amazon.com/dp/B0XXXXXXXX or a 10-character ASIN',
    usesQueue: false,
  },
  pokemoncenter: {
    id: 'pokemoncenter',
    name: 'Pokémon Center',
    color: '#c7a6ff',
    hosts: ['pokemoncenter.com'],
    productIdLabel: 'Product ID',
    inputHint: 'https://www.pokemoncenter.com/product/290-12345/... (full URL)',
    usesQueue: true,
  },
};

export const RETAILER_LIST: RetailerMeta[] = RETAILER_IDS.map((id) => RETAILERS[id]);

export interface ParsedProduct {
  productId: string;
  url: string;
}

export type ParseOutcome = { ok: true; product: ParsedProduct } | { ok: false; error: string };

function toUrl(input: string): URL | null {
  const trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    return new URL(trimmed);
  } catch {
    return null;
  }
}

function hostMatches(url: URL, hosts: string[]): boolean {
  const host = url.hostname.toLowerCase();
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Which retailer a URL belongs to, or null if it is not a supported store. */
export function detectRetailer(input: string): RetailerId | null {
  const url = toUrl(input);
  if (!url) return null;
  return RETAILER_IDS.find((id) => hostMatches(url, RETAILERS[id].hosts)) ?? null;
}

/** Strip the fragment and tracking parameters, keep the path and meaningful query. */
function cleanUrl(url: URL, keepParams: string[]): string {
  const clean = new URL(url.origin + url.pathname);
  for (const key of keepParams) {
    const value = url.searchParams.get(key);
    if (value) clean.searchParams.set(key, value);
  }
  return clean.toString();
}

export function canonicalProductUrl(retailer: RetailerId, productId: string): string {
  switch (retailer) {
    case 'target':
      return `https://www.target.com/p/-/A-${productId}`;
    case 'bestbuy':
      return `https://www.bestbuy.com/site/${productId}.p?skuId=${productId}`;
    case 'amazon':
      return `https://www.amazon.com/dp/${productId}`;
    case 'pokemoncenter':
      return `https://www.pokemoncenter.com/product/${productId}`;
  }
}

function parseTarget(input: string, url: URL | null): ParseOutcome {
  if (!url) {
    const raw = input.trim();
    if (/^\d{6,10}$/.test(raw)) return { ok: true, product: { productId: raw, url: canonicalProductUrl('target', raw) } };
    return { ok: false, error: 'Enter a Target product URL or a TCIN (6-10 digits).' };
  }
  const preselect = url.searchParams.get('preselect');
  const match = /\/A-(\d{6,10})(?:[/?#]|$)/i.exec(url.pathname);
  const tcin = preselect && /^\d{6,10}$/.test(preselect) ? preselect : match?.[1];
  if (!tcin) return { ok: false, error: 'Could not find a TCIN (the "A-12345678" part) in this Target URL.' };
  return { ok: true, product: { productId: tcin, url: cleanUrl(url, preselect ? ['preselect'] : []) } };
}

function parseBestBuy(input: string, url: URL | null): ParseOutcome {
  if (!url) {
    const raw = input.trim();
    if (/^\d{6,8}$/.test(raw)) return { ok: true, product: { productId: raw, url: canonicalProductUrl('bestbuy', raw) } };
    return { ok: false, error: 'Enter a Best Buy product URL or a SKU (6-8 digits).' };
  }
  const sku =
    url.searchParams.get('skuId')?.match(/^\d{6,8}$/)?.[0] ??
    /\/(\d{6,8})\.p(?:[/?#]|$)/i.exec(url.pathname)?.[1] ??
    /\/sku\/(\d{6,8})(?:[/?#]|$)/i.exec(url.pathname)?.[1];
  if (!sku) return { ok: false, error: 'Could not find a SKU in this Best Buy URL (look for skuId=...).' };
  return { ok: true, product: { productId: sku, url: cleanUrl(url, ['skuId']) } };
}

const ASIN = /^(?:B0[A-Z0-9]{8}|\d{9}[\dX])$/i;

function parseAmazon(input: string, url: URL | null): ParseOutcome {
  if (!url) {
    const raw = input.trim().toUpperCase();
    if (ASIN.test(raw)) return { ok: true, product: { productId: raw, url: canonicalProductUrl('amazon', raw) } };
    return { ok: false, error: 'Enter an Amazon.com product URL or a 10-character ASIN.' };
  }
  const match = /\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/asin|product)\/([A-Z0-9]{10})(?:[/?#]|$)/i.exec(url.pathname);
  const asin = match?.[1]?.toUpperCase();
  if (!asin || !ASIN.test(asin)) return { ok: false, error: 'Could not find an ASIN in this Amazon URL (look for /dp/...).' };
  return { ok: true, product: { productId: asin, url: canonicalProductUrl('amazon', asin) } };
}

function parsePokemonCenter(_input: string, url: URL | null): ParseOutcome {
  if (!url) return { ok: false, error: 'Paste the full Pokémon Center product URL.' };
  const match = /\/product\/(\d{1,5}(?:-[0-9A-Z]{1,8}){1,3})(?:[/?#]|$)/i.exec(url.pathname);
  if (!match?.[1]) return { ok: false, error: 'Could not find a product id (like 290-12345) in this Pokémon Center URL.' };
  return { ok: true, product: { productId: match[1], url: cleanUrl(url, []) } };
}

/** Parse a product URL or bare id for the given retailer. */
export function parseProductInput(retailer: RetailerId, input: string): ParseOutcome {
  const url = toUrl(input);
  if (url && !hostMatches(url, RETAILERS[retailer].hosts)) {
    const other = detectRetailer(input);
    return {
      ok: false,
      error: other
        ? `This is a ${RETAILERS[other].name} URL. Pick ${RETAILERS[other].name} as the retailer.`
        : `This URL is not on ${RETAILERS[retailer].hosts.join(', ')}.`,
    };
  }
  if (!url && /^https?:/i.test(input.trim())) return { ok: false, error: 'That URL is not valid.' };
  switch (retailer) {
    case 'target':
      return parseTarget(input, url);
    case 'bestbuy':
      return parseBestBuy(input, url);
    case 'amazon':
      return parseAmazon(input, url);
    case 'pokemoncenter':
      return parsePokemonCenter(input, url);
  }
}

/** Only these hosts may be opened from the UI with the system browser. */
export function isRetailerUrl(input: string): boolean {
  return detectRetailer(input) !== null;
}

/** A readable title from a product URL's slug, e.g. ".../pokemon-tcg-elite-trainer-box/-/A-123" -> "Pokemon Tcg Elite Trainer Box". */
export function titleFromUrl(input: string): string | null {
  const url = toUrl(input);
  if (!url) return null;
  const slug = url.pathname
    .split('/')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .filter((part) => /[a-z]{3,}/i.test(part) && part.includes('-') && !/^(?:A-\d+|\d+(?:-\d+)*)$/i.test(part))
    .sort((a, b) => b.length - a.length)[0];
  if (!slug) return null;
  return slug
    .replace(/\.p$/i, '')
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
    .slice(0, 120);
}
