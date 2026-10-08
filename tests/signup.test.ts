import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {}, app: { getPath: () => '/tmp' }, safeStorage: {} }));

const { generatePassword, parseEmails } = await import('../src/main/engine/signup');
const { signupRequestSchema } = await import('../src/shared/schemas');

describe('assisted sign-up', () => {
  it('generates strong, different passwords', () => {
    const passwords = Array.from({ length: 50 }, () => generatePassword());
    for (const p of passwords) {
      expect(p).toHaveLength(16);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/\d/);
      expect(p).toMatch(/[!@#$%*?]/);
    }
    expect(new Set(passwords).size).toBe(50);
  });

  it('reads one email per line, drops repeats and reports bad lines', () => {
    expect(parseEmails('a@x.com\n\nB@x.com, a@X.com\nnot-an-email\nc@y.org')).toEqual({
      emails: ['a@x.com', 'B@x.com', 'c@y.org'],
      invalid: ['not-an-email'],
    });
    expect(parseEmails('me@x.com:password').invalid).toEqual(['me@x.com:password']);
  });

  it('needs a profile, and a real password when one is shared', () => {
    const base = { retailer: 'target', emails: 'a@x.com', profileId: 'p1', passwordMode: 'generate', password: '', labelPrefix: '', linkProfile: true };
    expect(signupRequestSchema.safeParse(base).success).toBe(true);
    expect(signupRequestSchema.safeParse({ ...base, profileId: '' }).success).toBe(false);
    expect(signupRequestSchema.safeParse({ ...base, passwordMode: 'same', password: 'short' }).success).toBe(false);
    expect(signupRequestSchema.safeParse({ ...base, passwordMode: 'same', password: 'Long-enough-1' }).success).toBe(true);
  });
});
