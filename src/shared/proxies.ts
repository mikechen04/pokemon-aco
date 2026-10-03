// Parsing for the optional user-provided proxy list. Only plain HTTP proxies are supported.
// Accepted line formats:
//   host:port
//   host:port:username:password
//   username:password@host:port
//   http://host:port   or   http://username:password@host:port

export interface ProxyEntry {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface ProxyParseResult {
  proxies: ProxyEntry[];
  invalid: string[];
}

const HOST = /^[a-z0-9.-]+$/i;

function validPort(value: string | undefined): number | null {
  if (!value || !/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
}

export function parseProxyLine(line: string): ProxyEntry | null {
  let text = line.trim();
  if (!text) return null;
  const scheme = /^([a-z0-9]+):\/\//i.exec(text);
  if (scheme) {
    if (scheme[1]?.toLowerCase() !== 'http') return null;
    text = text.slice(scheme[0].length).replace(/\/+$/, '');
  }

  if (text.includes('@')) {
    const at = text.lastIndexOf('@');
    const creds = text.slice(0, at);
    const [host, portText, ...rest] = text.slice(at + 1).split(':');
    const sep = creds.indexOf(':');
    const port = validPort(portText);
    if (rest.length || sep < 1 || !host || !HOST.test(host) || port === null) return null;
    return {
      host,
      port,
      username: decodeURIComponent(creds.slice(0, sep)),
      password: decodeURIComponent(creds.slice(sep + 1)),
    };
  }

  const parts = text.split(':');
  const [host, portText, username, ...passwordParts] = parts;
  const port = validPort(portText);
  if (!host || !HOST.test(host) || port === null) return null;
  if (parts.length === 2) return { host, port };
  if (parts.length >= 4 && username) return { host, port, username, password: passwordParts.join(':') };
  return null;
}

export function parseProxyList(text: string): ProxyParseResult {
  const result: ProxyParseResult = { proxies: [], invalid: [] };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const proxy = parseProxyLine(line);
    if (proxy) result.proxies.push(proxy);
    else result.invalid.push(line.trim());
  }
  return result;
}

/** Chromium proxy rule: one HTTP proxy for every URL scheme. */
export function proxyRules(proxy: ProxyEntry): string {
  return `http://${proxy.host}:${proxy.port}`;
}

/** Safe for logs and UI: never includes credentials. */
export function describeProxy(proxy: ProxyEntry): string {
  return `${proxy.host}:${proxy.port}${proxy.username ? ' (auth)' : ''}`;
}
