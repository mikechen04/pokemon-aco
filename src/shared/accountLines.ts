// Parses the bulk-add text for accounts: one account per line.
//   email:password        email,password        email<TAB>password        email
// Everything after the first separator is the password, so passwords may contain ":" or ",".
// Blank lines and lines starting with "#" are ignored. Error messages never echo passwords.

export interface AccountLine {
  email: string;
  password: string;
}

export interface AccountLinesResult {
  entries: AccountLine[];
  errors: string[];
  duplicates: number;
}

export const MAX_BULK_ACCOUNTS = 500;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[\d\s().-]{7,20}$/;

/** Retailer logins are an email address, or a phone number (Amazon allows mobile sign-in). */
export function isValidLogin(login: string): boolean {
  const value = login.trim();
  if (value.length < 3 || value.length > 254) return false;
  return EMAIL.test(value) || (PHONE.test(value) && value.replace(/\D/g, '').length >= 7);
}

export function parseAccountLines(text: string): AccountLinesResult {
  const result: AccountLinesResult = { entries: [], errors: [], duplicates: 0 };
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const separator = /[:,\t]/.exec(line);
    const email = (separator ? line.slice(0, separator.index) : line).trim();
    const password = separator ? line.slice(separator.index + 1).trim() : '';
    const lineNo = index + 1;
    if (!isValidLogin(email)) {
      // Never echo the line: with an unexpected separator it could contain the password.
      result.errors.push(`Line ${lineNo}: not an email address or phone number (format: email:password)`);
      return;
    }
    if (password.length > 256) {
      result.errors.push(`Line ${lineNo}: the password is longer than 256 characters`);
      return;
    }
    const key = email.toLowerCase();
    if (seen.has(key)) {
      result.duplicates++;
      return;
    }
    seen.add(key);
    result.entries.push({ email, password });
  });
  if (result.entries.length > MAX_BULK_ACCOUNTS) {
    result.errors.push(`Only ${MAX_BULK_ACCOUNTS} accounts can be added at once; the rest were ignored`);
    result.entries = result.entries.slice(0, MAX_BULK_ACCOUNTS);
  }
  return result;
}
