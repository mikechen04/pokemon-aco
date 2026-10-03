import { describe, expect, it } from 'vitest';
import { redact, registerSecret } from '../src/main/core/redact';
import { emptyFillReport, mergeFillReports } from '../src/main/engine/fillScripts';
import { mentionsCardLast4, mentionsOtherCard } from '../src/main/engine/guards';
import { cardFillProblem } from '../src/main/retailers/flows';
import { cardBrand, cardExpired, cvvLength, formatCardNumber, formatExpiry, luhnValid } from '../src/shared/cards';
import { cardInputSchema } from '../src/shared/schemas';

const nextYear = new Date().getFullYear() + 1;
const visa = { holder: 'Ash Ketchum', number: '4242 4242 4242 4242', expMonth: 1, expYear: nextYear, cvv: '123' };

describe('card helpers', () => {
  it('recognizes card networks from the number', () => {
    expect(cardBrand('4242424242424242')).toBe('visa');
    expect(cardBrand('5555 5555 5555 4444')).toBe('mastercard');
    expect(cardBrand('2223003122003222')).toBe('mastercard');
    expect(cardBrand('378282246310005')).toBe('amex');
    expect(cardBrand('6011111111111117')).toBe('discover');
    expect(cardBrand('3530111333300000')).toBe('other');
    expect(cvvLength('amex')).toBe(4);
    expect(cvvLength('visa')).toBe(3);
  });

  it('checks the Luhn digit and expiry month', () => {
    expect(luhnValid('4242424242424242')).toBe(true);
    expect(luhnValid('4242424242424241')).toBe(false);
    expect(luhnValid('42a2')).toBe(false);
    const oct2026 = new Date(2026, 9, 3);
    expect(cardExpired(10, 2026, oct2026)).toBe(false);
    expect(cardExpired(9, 2026, oct2026)).toBe(true);
    expect(cardExpired(1, 2027, oct2026)).toBe(false);
    expect(formatExpiry(3, 2029)).toBe('03/29');
  });

  it('groups digits the way they are printed', () => {
    expect(formatCardNumber('4242424242424242')).toBe('4242 4242 4242 4242');
    expect(formatCardNumber('378282246310005')).toBe('3782 822463 10005');
    expect(formatCardNumber('4242-42')).toBe('4242 42');
  });
});

describe('stored card validation', () => {
  it('accepts a valid card and strips spaces from the number', () => {
    const parsed = cardInputSchema.safeParse(visa);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.number).toBe('4242424242424242');
  });

  it('rejects typos, expired cards and wrong security code lengths', () => {
    expect(cardInputSchema.safeParse({ ...visa, number: '4242 4242 4242 4241' }).success).toBe(false);
    expect(cardInputSchema.safeParse({ ...visa, number: '4242' }).success).toBe(false);
    expect(cardInputSchema.safeParse({ ...visa, expMonth: 0 }).success).toBe(false);
    expect(cardInputSchema.safeParse({ ...visa, expMonth: 1, expYear: new Date().getFullYear() - 1 }).success).toBe(false);
    expect(cardInputSchema.safeParse({ ...visa, cvv: '1234' }).success).toBe(false);
    expect(cardInputSchema.safeParse({ ...visa, number: '378282246310005', cvv: '123' }).success).toBe(false);
    expect(cardInputSchema.safeParse({ ...visa, number: '378282246310005', cvv: '1234' }).success).toBe(true);
    expect(cardInputSchema.safeParse({ ...visa, holder: '' }).success).toBe(false);
    // The name field must not become a place to paste a second card number.
    expect(cardInputSchema.safeParse({ ...visa, holder: '5555555555554444' }).success).toBe(false);
  });

  it('never echoes the card number in validation messages', () => {
    const parsed = cardInputSchema.safeParse({ ...visa, number: '4242 4242 4242 4241' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) for (const issue of parsed.error.issues) expect(issue.message).not.toMatch(/4242/);
  });

  it('masks a stored number in logs, grouped or not', () => {
    registerSecret('4000056655665556');
    expect(redact('typed 4000056655665556 into the form')).not.toContain('4000056655665556');
    expect(redact('typed 4000 0566 5566 5556 into the form')).toBe('typed [card number removed] into the form');
  });
});

describe('checkout card checks', () => {
  it('tells which card the page shows', () => {
    expect(mentionsCardLast4('Visa ending in 4242', '4242')).toBe(true);
    expect(mentionsOtherCard('Visa ending in 1111', '4242')).toBe(true);
    expect(mentionsOtherCard('Mastercard •••• 4242', '4242')).toBe(false);
    expect(mentionsOtherCard('Order total $49.99, ZIP 95060', '4242')).toBe(false);
  });

  it('reports a card field that did not take its value', () => {
    const full = mergeFillReports([
      { ...emptyFillReport(), seen: { number: true, exp: true, cvv: false, name: true }, done: { number: true, exp: true, cvv: false, name: true } },
      { ...emptyFillReport(), seen: { number: false, exp: false, cvv: true, name: false }, done: { number: false, exp: false, cvv: true, name: false } },
    ]);
    expect(cardFillProblem(full, 'full')).toBeNull();
    expect(cardFillProblem(emptyFillReport(), 'full')).toMatch(/no card number field/);
    expect(cardFillProblem(emptyFillReport(), 'cvv')).toMatch(/no security code field/);
    const stuck = { ...full, done: { ...full.done, exp: false } };
    expect(cardFillProblem(stuck, 'full')).toMatch(/expiry date/);
    // In security-code mode only the code matters.
    expect(cardFillProblem(stuck, 'cvv')).toBeNull();
  });
});
