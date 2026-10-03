/**
 * The Referer a browser sends under its default policy (strict-origin-when-cross-origin):
 * the full URL to the same origin, only the origin cross-origin, nothing on HTTPS -> HTTP.
 * Chromium's network stack cancels requests whose Referer breaks that policy, so the HTTP
 * client always passes referrers through this.
 */
export function refererFor(referer: string, target: string): string | null {
  try {
    const from = new URL(referer);
    const to = new URL(target);
    if (from.protocol === 'https:' && to.protocol === 'http:') return null;
    if (from.origin === to.origin) return from.href.split('#')[0] ?? null;
    return `${from.origin}/`;
  } catch {
    return null;
  }
}
