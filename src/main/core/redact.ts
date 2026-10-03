// Scrubs secrets out of any text before it is logged, shown in the UI or sent to Discord.
// Two layers: exact values registered at runtime (passwords, webhook URL, proxy credentials,
// API keys) and patterns (tokens, cookies, card-like numbers, email addresses).
import { looksLikeCardNumber } from '../../shared/schemas';

const MASK = '••••';
const secrets = new Set<string>();

export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 4) secrets.add(value);
}

export function forgetSecret(value: string | undefined | null): void {
  if (value) secrets.delete(value);
}

export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return email.length > 2 ? `${email.slice(0, 2)}${MASK}` : MASK;
  const name = email.slice(0, at);
  return `${name.slice(0, Math.min(2, name.length))}${MASK}@${email.slice(at + 1)}`;
}

// Header-style lines whose whole value is secret (it can contain spaces and semicolons).
const HEADER_LINE = /\b(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/gi;
const AUTH_SCHEME = /\b(Bearer)\s+[A-Za-z0-9\-._~+/]{8,}=*|\b(Basic)\s+[A-Za-z0-9+/]{8,}={0,2}/g;
const KEY_VALUE =
  /\b(x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|password|passwd|cvv|cvc|security[-_]?code)(["']?\s*[:=]\s*["']?)([^"'\s&;,}]+)/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const DIGIT_RUN = /\d(?:[ -]?\d){12,18}/g;
// Amazon order numbers (123-1234567-1234567) are long digit runs too; keep them readable.
const AMAZON_ORDER = /^\d{3}-\d{7}-\d{7}$/;

export function redact(input: string): string {
  let out = input;
  // Longest first so a secret that contains another is fully removed.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (out.includes(secret)) out = out.split(secret).join(MASK);
  }
  out = out.replace(HEADER_LINE, (_m, key: string) => `${key}: ${MASK}`);
  out = out.replace(AUTH_SCHEME, (_m, bearer?: string, basic?: string) => `${bearer ?? basic} ${MASK}`);
  out = out.replace(KEY_VALUE, (_m, key: string, sep: string) => `${key}${sep}${MASK}`);
  out = out.replace(DIGIT_RUN, (run) =>
    !AMAZON_ORDER.test(run) && looksLikeCardNumber(run) ? '[card number removed]' : run,
  );
  out = out.replace(EMAIL, (email) => maskEmail(email));
  return out;
}
