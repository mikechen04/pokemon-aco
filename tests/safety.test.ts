import { describe, expect, it } from 'vitest';
import { maskEmail, redact, registerSecret } from '../src/main/core/redact';
import { mergeOverrides } from '../src/main/data/overrides';
import { refererFor } from '../src/main/engine/referrer';
import { firstIssue, looksLikeCardNumber, profileInputSchema, settingsPatchSchema, taskCreateSchema } from '../src/shared/schemas';

const address = { firstName: 'Ash', lastName: 'Ketchum', address1: '123 Main St', address2: '', city: 'Santa Cruz', state: 'CA', zip: '95060', phone: '831-555-0100' };

describe('card data guard', () => {
  it('spots card-like numbers with a valid Luhn checksum', () => {
    expect(looksLikeCardNumber('4111 1111 1111 1111')).toBe(true);
    expect(looksLikeCardNumber('my card 4111-1111-1111-1111 thanks')).toBe(true);
    expect(looksLikeCardNumber('4111 1111 1111 1112')).toBe(false);
    expect(looksLikeCardNumber('call 831-555-0100')).toBe(false);
    expect(looksLikeCardNumber('1234')).toBe(false);
  });

  it('rejects full card numbers anywhere in a profile, and anything but 4 digits for last4', () => {
    const base = { name: 'Home', shipping: address, billingSameAsShipping: true, billing: address, cardLast4: '4242', cardLabel: '' };
    expect(profileInputSchema.safeParse(base).success).toBe(true);
    const leaked = profileInputSchema.safeParse({ ...base, cardLabel: '4111111111111111' });
    expect(leaked.success).toBe(false);
    expect(!leaked.success && firstIssue(leaked.error)).toMatch(/card numbers/);
    expect(profileInputSchema.safeParse({ ...base, cardLast4: '424' }).success).toBe(false);
    expect(profileInputSchema.safeParse({ ...base, cardLast4: '4111111111111111' }).success).toBe(false);
  });
});

describe('settings validation', () => {
  it('only accepts Discord webhook URLs and sane limits', () => {
    expect(settingsPatchSchema.safeParse({ webhookUrl: 'https://discord.com/api/webhooks/123456789012/abcdefghijklmnopqrstuvwxyz_-' }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ webhookUrl: 'https://evil.example/collect' }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ pollIntervalMs: 500 }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ maxQuantityPerTask: 11 }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ unknownKey: true }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ proxies: 'socks5://1.2.3.4:1080' }).success).toBe(false);
  });
});

describe('task creation validation', () => {
  const input = { retailer: 'target', mode: 'url', input: '12345678', profileId: 'p', accountId: 'a', quantity: 1, maxPrice: 49.99 };
  it('accepts multi-account groups with an optional goal', () => {
    expect(taskCreateSchema.safeParse({ input, accountIds: ['a', 'b', 'c'], useAccountProfiles: true, copies: 1, groupName: 'Drop', groupGoal: 2 }).success).toBe(true);
    expect(taskCreateSchema.safeParse({ input, accountIds: ['a'], useAccountProfiles: false, copies: 1, groupName: '', groupGoal: null }).success).toBe(true);
  });
  it('rejects empty account lists, bad goals and bad products', () => {
    expect(taskCreateSchema.safeParse({ input, accountIds: [], useAccountProfiles: true, copies: 1, groupName: '', groupGoal: null }).success).toBe(false);
    expect(taskCreateSchema.safeParse({ input, accountIds: ['a'], useAccountProfiles: true, copies: 1, groupName: '', groupGoal: 0 }).success).toBe(false);
    const bad = taskCreateSchema.safeParse({ input: { ...input, input: 'https://www.target.com/c/toys' }, accountIds: ['a'], useAccountProfiles: true, copies: 1, groupName: '', groupGoal: null });
    expect(bad.success).toBe(false);
  });
});

describe('redact', () => {
  it('removes registered secrets, tokens, card numbers and masks emails', () => {
    registerSecret('hunter2-super-secret');
    const out = redact(
      'login failed for ash.ketchum@example.com with hunter2-super-secret; Authorization: Bearer abc.def.ghi; password=letmein; card 4111 1111 1111 1111',
    );
    expect(out).not.toContain('hunter2-super-secret');
    expect(out).not.toContain('abc.def.ghi');
    expect(out).not.toContain('letmein');
    expect(out).not.toContain('4111 1111 1111 1111');
    expect(out).not.toContain('ash.ketchum@example.com');
    expect(out).toContain('as••••@example.com');
  });

  it('masks bearer tokens in free text but leaves ordinary words alone', () => {
    expect(redact('retrying with Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig now')).toBe('retrying with Bearer •••• now');
    expect(redact('Token expired, signing in again')).toBe('Token expired, signing in again');
  });

  it('keeps Amazon order numbers readable', () => {
    expect(redact('Order placed (#112-1234567-1234567)')).toContain('112-1234567-1234567');
    expect(maskEmail('x@y.com')).toBe('x••••@y.com');
  });
});

describe('retailer overrides', () => {
  it('only overrides known keys with values of the same type', () => {
    const defaults = { apiKey: 'abc', urls: { cart: 'https://a' }, statuses: ['IN_STOCK'], retries: 3 };
    const merged = mergeOverrides(defaults, { apiKey: 'new', urls: { cart: 'https://b', extra: 'x' }, statuses: ['A', 'B'], retries: 'ten', unknown: 1 });
    expect(merged).toEqual({ apiKey: 'new', urls: { cart: 'https://b' }, statuses: ['A', 'B'], retries: 3 });
    expect(mergeOverrides(defaults, null)).toEqual(defaults);
  });
});

describe('refererFor', () => {
  it('follows the browser default referrer policy', () => {
    expect(refererFor('https://www.target.com/p/x/-/A-1', 'https://www.target.com/cart')).toBe('https://www.target.com/p/x/-/A-1');
    expect(refererFor('https://www.target.com/p/x/-/A-1', 'https://redsky.target.com/api')).toBe('https://www.target.com/');
    expect(refererFor('https://www.target.com/p/x', 'http://127.0.0.1/api')).toBeNull();
    expect(refererFor('nonsense', 'https://a.com')).toBeNull();
  });
});
