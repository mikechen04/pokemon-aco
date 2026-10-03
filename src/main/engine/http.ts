// HTTP client on Electron's net module. Requests go through Chromium's own network stack
// with the session's cookie jar, so the direct-HTTP path and the browser fallback share
// one logged-in session. The client does not alter TLS, headers order or fingerprints.
import { net, type Session } from 'electron';
import type { ProxyEntry } from '../../shared/proxies';
import { classifyPage, isQueueUrl, type Detection } from './detection';
import { AbortedError, RetailerError } from './errors';
import { refererFor } from './referrer';

const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_REDIRECTS = 10;

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  /** Sent as application/json. */
  json?: unknown;
  /** Sent as application/x-www-form-urlencoded. */
  form?: URLSearchParams | Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  followRedirects?: boolean;
}

export interface HttpResponse {
  status: number;
  /** Final URL after redirects. */
  url: string;
  redirects: string[];
  headers: Record<string, string>;
  text: string;
  detection: Detection;
  json<T = unknown>(): T;
}

function flattenHeaders(headers: Record<string, string | string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  return out;
}

function makeResponse(status: number, url: string, redirects: string[], headers: Record<string, string>, text: string): HttpResponse {
  return {
    status,
    url,
    redirects,
    headers,
    text,
    detection: classifyPage({ url, status, text, headers }),
    json<T>() {
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new RetailerError(`Expected JSON from ${new URL(url).hostname} but got something else (HTTP ${status})`);
      }
    },
  };
}

export class HttpClient {
  constructor(
    private readonly session: Session,
    private readonly getProxy: () => ProxyEntry | undefined,
    private readonly defaultTimeoutMs: () => number,
  ) {}

  request(req: HttpRequest): Promise<HttpResponse> {
    const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs();
    const follow = req.followRedirects !== false;
    return new Promise<HttpResponse>((resolve, reject) => {
      if (req.signal?.aborted) {
        reject(new AbortedError());
        return;
      }
      const redirects: string[] = [];
      let currentUrl = req.url;
      let settled = false;
      const request = net.request({
        method: req.method ?? 'GET',
        url: req.url,
        session: this.session,
        useSessionCookies: true,
        redirect: 'manual',
        cache: 'no-store',
      });

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = () => {
        finish(() => reject(new AbortedError()));
        request.abort();
      };
      const timer = setTimeout(() => {
        finish(() => reject(new RetailerError(`Request to ${new URL(req.url).hostname} timed out after ${Math.round(timeoutMs / 1000)}s`)));
        request.abort();
      }, timeoutMs);
      req.signal?.addEventListener('abort', onAbort, { once: true });

      const headers: Record<string, string> = {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        ...Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
      };
      if (headers.referer) {
        const referer = refererFor(headers.referer, req.url);
        if (referer) headers.referer = referer;
        else delete headers.referer;
      }
      let body: string | undefined = req.body;
      if (req.json !== undefined) {
        body = JSON.stringify(req.json);
        headers['content-type'] ??= 'application/json';
        if (!req.headers?.accept) headers.accept = 'application/json, text/plain, */*';
      } else if (req.form) {
        body = (req.form instanceof URLSearchParams ? req.form : new URLSearchParams(req.form)).toString();
        headers['content-type'] ??= 'application/x-www-form-urlencoded';
      }
      for (const [key, value] of Object.entries(headers)) request.setHeader(key, value);

      request.on('redirect', (status, _method, redirectUrl, responseHeaders) => {
        redirects.push(redirectUrl);
        // Stop at a waiting room or after too many hops; the caller decides what to do.
        if (!follow || isQueueUrl(redirectUrl) || redirects.length > MAX_REDIRECTS) {
          finish(() => resolve(makeResponse(status, redirectUrl, redirects, flattenHeaders(responseHeaders), '')));
          request.abort();
          return;
        }
        currentUrl = redirectUrl;
        request.followRedirect();
      });

      request.on('login', (authInfo, callback) => {
        const proxy = this.getProxy();
        if (authInfo.isProxy && proxy?.username) callback(proxy.username, proxy.password ?? '');
        else callback();
      });

      request.on('response', (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            finish(() => reject(new RetailerError('Response too large')));
            request.abort();
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          finish(() =>
            resolve(
              makeResponse(
                response.statusCode,
                currentUrl,
                redirects,
                flattenHeaders(response.headers),
                Buffer.concat(chunks).toString('utf8'),
              ),
            ),
          );
        });
        response.on('error', (err: Error) => finish(() => reject(new RetailerError(`Response error: ${err.message}`))));
      });

      request.on('error', (err) => {
        finish(() => reject(new RetailerError(`Network error contacting ${new URL(req.url).hostname}: ${err.message}`)));
      });

      if (body !== undefined) request.write(body);
      request.end();
    });
  }

  get(url: string, options: Omit<HttpRequest, 'url' | 'method'> = {}): Promise<HttpResponse> {
    return this.request({ ...options, url, method: 'GET' });
  }

  post(url: string, options: Omit<HttpRequest, 'url' | 'method'> = {}): Promise<HttpResponse> {
    return this.request({ ...options, url, method: 'POST' });
  }
}
