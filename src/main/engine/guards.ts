// Checks run against the checkout page before an order is placed. If any of them cannot
// be confirmed, the task pauses for review instead of buying.
import { normalizeText } from '../../shared/keywords';
import { centsOf, formatUsd, parsePrice } from '../../shared/money';
import type { Address } from '../../shared/types';

const ABBREVIATIONS: Record<string, string> = {
  street: 'st',
  avenue: 'ave',
  road: 'rd',
  drive: 'dr',
  boulevard: 'blvd',
  lane: 'ln',
  court: 'ct',
  place: 'pl',
  circle: 'cir',
  highway: 'hwy',
  parkway: 'pkwy',
  terrace: 'ter',
  trail: 'trl',
  square: 'sq',
  apartment: 'apt',
  suite: 'ste',
  north: 'n',
  south: 's',
  east: 'e',
  west: 'w',
};
const DIRECTIONS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);

function normalizeAddressText(text: string): string {
  return normalizeText(text)
    .split(' ')
    .map((word) => ABBREVIATIONS[word] ?? word)
    .join(' ');
}

/**
 * True when the page shows the profile's address: same 5-digit ZIP, same house number
 * and the first street-name word. Tolerates abbreviations and capitalization.
 */
export function addressMatches(pageText: string, address: Address): boolean {
  const page = ` ${normalizeAddressText(pageText)} `;
  const zip5 = address.zip.trim().slice(0, 5);
  if (!/^\d{5}$/.test(zip5) || !page.includes(` ${zip5} `)) return false;
  const words = normalizeAddressText(address.address1).split(' ').filter(Boolean);
  const house = words[0];
  if (!house || !page.includes(` ${house} `)) return false;
  const streetWord = words.slice(1).find((w) => w.length > 1 && !DIRECTIONS.has(w));
  return !streetWord || page.includes(` ${streetWord} `);
}

/** True when the text shows a card ending in `last4` ("ending in 1234", "•••• 1234", "x1234"). */
export function mentionsCardLast4(text: string, last4: string): boolean {
  if (!/^\d{4}$/.test(last4)) return false;
  const pattern = new RegExp(
    `(?:ending\\s*(?:in|with)?|ends\\s*(?:in|with)|[•*·.xX]{2,}|\\bx|last\\s*(?:4|four)(?:\\s*digits)?\\s*:?)\\s*[-:]?\\s*${last4}(?!\\d)`,
    'i',
  );
  return pattern.test(text);
}

const SUBTOTAL =
  /(?:item\(?s?\)?\s*subtotal|merchandise\s*subtotal|items?\s*subtotal|\bsubtotal|\bitems?\s*(?:\(\s*\d+\s*\))?\s*:)\s*(?:\(\s*\d+\s*items?\s*\))?\s*:?\s*\$\s*([\d,]+\.\d{2})/i;
const ORDER_TOTAL = /(?:order\s*total|estimated\s*total|grand\s*total|(?<!sub)\btotal(?:\s*(?:due|price))?)\s*:?\s*\$\s*([\d,]+\.\d{2})/i;

export function extractSubtotal(text: string): number | null {
  const match = SUBTOTAL.exec(text);
  return match?.[1] ? parsePrice(match[1]) : null;
}

export function extractOrderTotal(text: string): number | null {
  const match = ORDER_TOTAL.exec(text);
  return match?.[1] ? parsePrice(match[1]) : null;
}

export interface PriceCheck {
  ok: boolean;
  message: string;
}

/**
 * The item subtotal (before tax and shipping) must be at most maxPrice x quantity.
 * A subtotal that is larger also means other items are in the cart.
 */
export function checkSubtotal(subtotal: number | null, maxPrice: number, quantity: number): PriceCheck {
  if (subtotal === null) return { ok: false, message: 'Could not read the order subtotal on the checkout page' };
  const limit = maxPrice * quantity;
  if (centsOf(subtotal) > centsOf(limit)) {
    return {
      ok: false,
      message: `Subtotal ${formatUsd(subtotal)} is above the limit ${formatUsd(limit)} (${quantity} x ${formatUsd(maxPrice)}). Other items may be in the cart.`,
    };
  }
  return { ok: true, message: `Subtotal ${formatUsd(subtotal)} within limit ${formatUsd(limit)}` };
}

export function extractOrderNumber(text: string): string | null {
  const match = /order\s*(?:number|no\.?|#|id)\s*(?:is)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,30})/i.exec(text);
  const value = match?.[1];
  return value && /\d/.test(value) ? value : null;
}

const CONFIRMATION =
  /thank(?:s| you) for (?:your|the) (?:order|purchase)|your order (?:has been|was|is) (?:placed|received|submitted|confirmed)|order (?:placed|confirmed)(?!\s*\?)|we(?:'|’)ve received your order|order confirmation/i;

export function looksLikeConfirmation(url: string, text: string): boolean {
  if (CONFIRMATION.test(text)) return true;
  return /thank-?you|confirmation|order-?confirm/i.test(url) && /order\s*(?:number|#)/i.test(text);
}

const DECLINED =
  /(?:card|payment)(?: method)? (?:was |has been )?declined|unable to (?:process|authorize) (?:your )?payment|payment (?:could not|couldn(?:'|’)t) be (?:processed|authorized)|there (?:was|is) (?:a|an) (?:problem|issue|error) with your payment|please (?:update|use) (?:a )?(?:different|another) payment/i;

export function looksDeclined(text: string): boolean {
  return DECLINED.test(text);
}

const OUT_OF_STOCK =
  /\bout of stock\b|\bsold out\b|currently unavailable|no longer available|not available for (?:shipping|delivery)|item is unavailable|exceeds? (?:the )?(?:available|purchase) (?:quantity|limit)/i;

export function looksOutOfStock(text: string): boolean {
  return OUT_OF_STOCK.test(text);
}

const CVV_PROMPT = /(?:enter|re-?enter|confirm|verify|add)\s+(?:your\s+|the\s+)?(?:cvv|cvc|security code|card verification)/i;

export function looksLikeCvvPrompt(text: string): boolean {
  return CVV_PROMPT.test(text);
}
