// Classifies an HTTP response or a loaded page: normal content, a waiting-room queue,
// a CAPTCHA, a bot challenge, or a block. The engine uses the result to pause a task or
// wait in a queue. It never tries to solve or bypass any of these.

export type PageKind =
  | 'ok'
  | 'queue'
  | 'captcha'
  | 'bot_challenge'
  | 'blocked'
  | 'rate_limited'
  | 'not_found'
  | 'server_error';

export interface PageSample {
  url: string;
  status?: number;
  /** Visible page text (DOM) or the raw response body (HTTP). Only the first ~400 KB is scanned. */
  text: string;
  /** Raw markup of a loaded page; scanned for CAPTCHA and challenge markers only. */
  html?: string;
  /** 'dom' = text is what a user would see, so wording checks use tighter size limits. */
  source?: 'http' | 'dom';
  headers?: Record<string, string>;
}

export interface Detection {
  kind: PageKind;
  detail: string;
  provider?: string;
  retryAfterMs?: number;
}

const QUEUE_HOST = /(^|\.)queue-it\.net$|^queue\./i;
const QUEUE_PATH = /\/(waiting-?room|queue-?it)(\/|$|\?)/i;
// Visible waiting-room wording. Queue providers' scripts are embedded on every page of
// some sites, so script names are deliberately not used as markers.
const QUEUE_TEXT: Array<[RegExp, string]> = [
  [/you(?:'|’| a)re now in line/i, 'waiting room'],
  [/you are (?:currently )?in (?:the )?(?:virtual )?(?:queue|line|waiting room)/i, 'waiting room'],
  [/your (?:number|place|position) in (?:line|the queue)/i, 'waiting room'],
  [/(?:estimated|expected) wait(?:ing)? time/i, 'waiting room'],
  [/virtual (?:queue|waiting room)/i, 'waiting room'],
  [/\bwaiting room\b/i, 'waiting room'],
];

const CAPTCHA_TEXT: Array<[RegExp, string]> = [
  [/\/errors\/validateCaptcha/i, 'Amazon CAPTCHA'],
  [/type the characters you see in this image/i, 'CAPTCHA'],
  [/enter the characters you see below/i, 'CAPTCHA'],
  [/make sure you(?:'|’)re not a robot/i, 'CAPTCHA'],
  [/captcha-delivery\.com/i, 'DataDome CAPTCHA'],
  [/id=["']?px-captcha|press (?:&|&amp;|and) hold/i, 'PerimeterX challenge'],
  [/verify (?:that )?you(?: are|'re) (?:a )?human/i, 'human verification'],
  [/are you a (?:human|robot)\?/i, 'human verification'],
  [/i(?:'|’)m not a robot/i, 'reCAPTCHA'],
];

const WEAK_CAPTCHA = /g-recaptcha|recaptcha\/api\.js|hcaptcha\.com\/1\/api\.js|h-captcha|arkoselabs|funcaptcha/i;

const CHALLENGE_TEXT: Array<[RegExp, string]> = [
  [/_sec\/cp_challenge|sec-if-cpt-container|sec-cpt-if/i, 'Akamai challenge'],
  [/challenge-platform|cf-chl-|cf_chl_|checking your browser before accessing|checking if the site connection is secure/i, 'Cloudflare challenge'],
  [/<title>\s*just a moment\.\.\.\s*<\/title>/i, 'Cloudflare challenge'],
  [/_Incapsula_Resource|incapsula incident id/i, 'Imperva/Incapsula'],
  [/perimeterx|_pxAppId|px-cdn\.net/i, 'PerimeterX'],
];

const BLOCK_TEXT: Array<[RegExp, string]> = [
  [/reference\s*#\s*\d+\.[0-9a-f]+\.\d+/i, 'Akamai block'],
  [/you don(?:'|’)t have permission to access/i, 'access denied'],
  [/access to this page has been denied/i, 'access denied'],
  [/request unsuccessful\.?\s*incapsula/i, 'Imperva/Incapsula block'],
  [/\baccess denied\b/i, 'access denied'],
  [/your (?:request|access) (?:has been|was) blocked/i, 'blocked'],
];

function firstMatch(text: string, patterns: Array<[RegExp, string]>): string | null {
  for (const [pattern, label] of patterns) if (pattern.test(text)) return label;
  return null;
}

function retryAfter(headers: Record<string, string> | undefined): number | undefined {
  const value = headers?.['retry-after'];
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 1), 600) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(Math.max(date - Date.now(), 1000), 600_000) : undefined;
}

export function isQueueUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return QUEUE_HOST.test(parsed.hostname) || QUEUE_PATH.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function classifyPage(sample: PageSample): Detection {
  const dom = sample.source === 'dom';
  const visible = sample.text.length > 400_000 ? sample.text.slice(0, 400_000) : sample.text;
  const markup = sample.html ? sample.html.slice(0, 400_000) : '';
  const all = markup ? `${visible}\n${markup}` : visible;
  const status = sample.status ?? 200;

  const captcha = firstMatch(all, CAPTCHA_TEXT);
  if (captcha) return { kind: 'captcha', detail: `${captcha} shown`, provider: captcha };
  // reCAPTCHA/hCaptcha/Arkose scripts also sit invisibly on normal login pages, so only
  // count them when the response itself is an error.
  if (status >= 400 && WEAK_CAPTCHA.test(all)) return { kind: 'captcha', detail: 'CAPTCHA shown', provider: 'CAPTCHA' };

  // Bot-protection scripts are embedded on every page of protected sites; a challenge is
  // an error response or a page with almost nothing else on it.
  const challenge = firstMatch(all, CHALLENGE_TEXT);
  const smallPage = dom ? visible.length < 3000 : all.length < 30_000;
  if (challenge && (status >= 400 || smallPage)) {
    return { kind: 'bot_challenge', detail: `${challenge} page`, provider: challenge };
  }

  if (isQueueUrl(sample.url)) return { kind: 'queue', detail: 'Waiting room', provider: 'waiting room' };
  // Waiting-room pages are small; a full product page that merely mentions a queue is not one.
  const queueSized = dom ? visible.length < 6000 : visible.length < 200_000;
  const queue = queueSized ? firstMatch(visible, QUEUE_TEXT) : null;
  if (queue) return { kind: 'queue', detail: 'Waiting room', provider: queue };

  if (status === 429) {
    const wait = retryAfter(sample.headers);
    return { kind: 'rate_limited', detail: 'Rate limited (HTTP 429)', ...(wait ? { retryAfterMs: wait } : {}) };
  }
  if (status === 403 || status === 401) {
    const block = firstMatch(all, BLOCK_TEXT);
    return { kind: 'blocked', detail: block ? `HTTP ${status}: ${block}` : `HTTP ${status} Forbidden`, provider: block ?? 'HTTP' };
  }
  if (status >= 400) {
    const block = firstMatch(all, BLOCK_TEXT);
    if (block && block !== 'access denied') return { kind: 'blocked', detail: `HTTP ${status}: ${block}`, provider: block };
  }
  if (status === 404 || status === 410) return { kind: 'not_found', detail: `HTTP ${status}` };
  if (status >= 500) return { kind: 'server_error', detail: `HTTP ${status}` };
  if (dom ? visible.length < 2000 : visible.length < 20_000) {
    const block = firstMatch(visible, BLOCK_TEXT);
    if (block) return { kind: 'blocked', detail: block, provider: block };
  }
  return { kind: 'ok', detail: `HTTP ${status}` };
}

/** Reads a queue position or wait time from waiting-room text, when the page shows one. */
export function queueProgress(text: string): string | null {
  const position = /(?:number|place|position) in line(?: is)?[:\s]*#?\s*([\d,]+)/i.exec(text)?.[1];
  const wait = /(?:estimated|expected) wait(?:ing)? time(?: is)?[:\s]*([^\n.]{1,40})/i.exec(text)?.[1]?.trim();
  const parts: string[] = [];
  if (position) parts.push(`position ${position}`);
  if (wait) parts.push(`est. wait ${wait}`);
  return parts.length ? parts.join(', ') : null;
}
