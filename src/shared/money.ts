// Price parsing and formatting (USD).

/** "$1,234.56", "USD 49.99", "49.99" -> number. Returns null when no price is present. */
export function parsePrice(text: string | number | null | undefined): number | null {
  if (typeof text === 'number') return Number.isFinite(text) && text >= 0 ? text : null;
  if (!text) return null;
  const match = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/.exec(text.replace(/\s+/g, ' '));
  if (!match?.[1]) return null;
  const whole = match[1].replace(/,/g, '');
  const cents = match[2] ? match[2].padEnd(2, '0') : '00';
  const value = Number(`${whole}.${cents}`);
  return Number.isFinite(value) ? value : null;
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/** Compare money values without floating point surprises. */
export function centsOf(value: number): number {
  return Math.round(value * 100);
}
