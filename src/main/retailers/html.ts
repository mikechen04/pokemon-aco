// HTML helpers for server-rendered product pages. JSON-LD (schema.org Product) is used
// first because stores publish it for search engines and it changes less than markup.
import { parse, type HTMLElement } from 'node-html-parser';
import { parsePrice } from '../../shared/money';

export function parseHtml(html: string): HTMLElement {
  return parse(html, { blockTextElements: { script: true, noscript: false, style: false, pre: true } });
}

export function textOf(root: HTMLElement, selectors: string[]): string | undefined {
  for (const selector of selectors) {
    const text = root.querySelector(selector)?.text.replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return undefined;
}

export function attrOf(root: HTMLElement, selectors: string[], attribute: string): string | undefined {
  for (const selector of selectors) {
    const value = root.querySelector(selector)?.getAttribute(attribute)?.trim();
    if (value) return value;
  }
  return undefined;
}

export function metaContent(root: HTMLElement, property: string): string | undefined {
  return attrOf(root, [`meta[property="${property}"]`, `meta[name="${property}"]`], 'content');
}

/** Every value stored under `key`, anywhere in a JSON tree (bounded depth). */
export function findKey(value: unknown, key: string, maxDepth = 14): unknown[] {
  const found: unknown[] = [];
  const walk = (node: unknown, depth: number) => {
    if (depth > maxDepth || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === key) found.push(v);
      walk(v, depth + 1);
    }
  };
  walk(value, 0);
  return found;
}

export function firstString(values: unknown[]): string | undefined {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim();
  return undefined;
}

export function firstNumber(values: unknown[]): number | undefined {
  for (const v of values) {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? parsePrice(v) : null;
    if (n !== null && Number.isFinite(n)) return n;
  }
  return undefined;
}

export interface JsonLdProduct {
  name?: string;
  image?: string;
  sku?: string;
  price?: number;
  /** schema.org availability, e.g. "InStock", "OutOfStock", "PreOrder". */
  availability?: string;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

export function jsonLdProducts(root: HTMLElement): JsonLdProduct[] {
  const products: JsonLdProduct[] = [];
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    let data: unknown;
    try {
      data = JSON.parse(script.text);
    } catch {
      continue;
    }
    const nodes = asArray(data).flatMap((node) => {
      const graph = (node as { '@graph'?: unknown })?.['@graph'];
      return graph ? asArray(graph) : [node];
    });
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const record = node as Record<string, unknown>;
      const types = asArray(record['@type']).map(String);
      if (!types.includes('Product')) continue;
      const offers = asArray(record.offers).flatMap((o) => {
        const nested = (o as { offers?: unknown })?.offers;
        return nested ? asArray(nested) : [o];
      }) as Array<Record<string, unknown>>;
      const offer = offers[0] ?? {};
      const image = asArray(record.image)[0];
      products.push({
        ...(typeof record.name === 'string' ? { name: record.name } : {}),
        ...(typeof image === 'string' ? { image } : typeof (image as { url?: unknown })?.url === 'string' ? { image: (image as { url: string }).url } : {}),
        ...(typeof record.sku === 'string' ? { sku: record.sku } : {}),
        ...(firstNumber([offer.price, offer.lowPrice]) !== undefined ? { price: firstNumber([offer.price, offer.lowPrice]) } : {}),
        ...(typeof offer.availability === 'string' ? { availability: offer.availability.replace(/^https?:\/\/schema\.org\//i, '') } : {}),
      });
    }
  }
  return products;
}

/** schema.org availability values that mean "you can buy it now". */
export function availabilityBuyable(availability: string | undefined): boolean | undefined {
  if (!availability) return undefined;
  if (/^(InStock|LimitedAvailability|OnlineOnly|PreOrder|PreSale|BackOrder)$/i.test(availability)) return true;
  if (/^(OutOfStock|SoldOut|Discontinued|InStoreOnly)$/i.test(availability)) return false;
  return undefined;
}

/** The Next.js page payload, when a store is built with Next.js. */
export function nextData(root: HTMLElement): unknown {
  const script = root.querySelector('script#__NEXT_DATA__');
  if (!script) return null;
  try {
    return JSON.parse(script.text);
  } catch {
    return null;
  }
}

/** Decodes a JWT's payload without verifying it (only used to read sign-in hints). */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
