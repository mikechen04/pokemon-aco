// Payment card helpers used by the UI (instant feedback) and the main process.
// A full card is only ever kept by the main process, encrypted with the OS key store.
import type { CardBrand } from './types';

export const CARD_BRAND_LABELS: Record<CardBrand, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  other: 'Card',
};

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

/** The Luhn checksum every real card number passes (catches most typos). */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Card network from the number's prefix. */
export function cardBrand(number: string): CardBrand {
  const d = digitsOnly(number);
  const six = d.length >= 6 ? Number(d.slice(0, 6)) : -1;
  if (/^4/.test(d)) return 'visa';
  if (/^3[47]/.test(d)) return 'amex';
  if (/^5[1-5]/.test(d) || (six >= 222100 && six <= 272099)) return 'mastercard';
  if (/^(6011|64[4-9]|65)/.test(d) || (six >= 622126 && six <= 622925)) return 'discover';
  return 'other';
}

/** Security code length: 4 digits for American Express, 3 for the other networks. */
export function cvvLength(brand: CardBrand): number {
  return brand === 'amex' ? 4 : 3;
}

/** Cards are valid through the last day of their expiry month. */
export function cardExpired(month: number, year: number, now = new Date()): boolean {
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  return year < currentYear || (year === currentYear && month < currentMonth);
}

/** "MM/YY" */
export function formatExpiry(month: number, year: number): string {
  return `${String(month).padStart(2, '0')}/${String(year % 100).padStart(2, '0')}`;
}

/** Groups digits the way they are printed on the card (4-6-5 for Amex, 4-4-4-4 otherwise). */
export function formatCardNumber(value: string): string {
  const d = digitsOnly(value).slice(0, 19);
  if (cardBrand(d) === 'amex') return [d.slice(0, 4), d.slice(4, 10), d.slice(10, 15)].filter(Boolean).join(' ');
  return d.replace(/(\d{4})(?=\d)/g, '$1 ');
}
