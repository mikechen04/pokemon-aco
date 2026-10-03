// Isolated browser profiles. Every retailer account gets its own persistent Chromium
// partition (cookies, storage, cache) that is completely separate from the user's own
// browsers. Stock monitors use one shared, logged-out partition per retailer.
//
// Proxies: when the user lists proxies, each session is given one and keeps it ("sticky").
// A blocked session is never moved to another proxy to get around the block.
import { session, type Session } from 'electron';
import { parseProxyList, proxyRules, type ProxyEntry } from '../../shared/proxies';
import type { RetailerId, Settings } from '../../shared/types';
import { HttpClient } from './http';

export interface SessionHandle {
  key: string;
  partition: string;
  session: Session;
  http: HttpClient;
  retailer: RetailerId;
  accountId?: string;
  proxy?: ProxyEntry;
}

/** webContents ids of automation windows that are currently hidden. */
const hiddenContents = new Set<number>();

export function setContentsHidden(id: number, hidden: boolean): void {
  if (hidden) hiddenContents.add(id);
  else hiddenContents.delete(id);
}

export class SessionManager {
  private readonly handles = new Map<string, SessionHandle>();
  private readonly pending = new Map<string, Promise<SessionHandle>>();
  private proxyList: ProxyEntry[] = [];
  private proxyText = '';

  constructor(private readonly getSettings: () => Settings) {
    this.syncProxyList(getSettings().proxies);
  }

  forAccount(accountId: string, retailer: RetailerId): Promise<SessionHandle> {
    return this.ensure(`acct:${accountId}`, `persist:acct-${accountId}`, retailer, accountId);
  }

  forMonitor(retailer: RetailerId): Promise<SessionHandle> {
    return this.ensure(`monitor:${retailer}`, `persist:monitor-${retailer}`, retailer);
  }

  private ensure(key: string, partition: string, retailer: RetailerId, accountId?: string): Promise<SessionHandle> {
    const existing = this.handles.get(key);
    if (existing) return Promise.resolve(existing);
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const created = (async () => {
      const ses = session.fromPartition(partition, { cache: true });
      this.configure(ses);
      const handle: SessionHandle = {
        key,
        partition,
        session: ses,
        retailer,
        ...(accountId ? { accountId } : {}),
        http: new HttpClient(
          ses,
          () => handle.proxy,
          () => this.getSettings().requestTimeoutMs,
        ),
      };
      await this.applyProxy(handle, this.proxyFor(this.handles.size));
      this.handles.set(key, handle);
      return handle;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, created);
    return created;
  }

  private configure(ses: Session): void {
    // Retailer pages get no notifications, camera, location or downloads.
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (event) => event.preventDefault());
    // Keep Chromium's own user agent unchanged; only pin the language.
    ses.setUserAgent(ses.getUserAgent(), 'en-US,en');
    // Speed: skip images and media in hidden automation windows. Visible windows load everything.
    ses.webRequest.onBeforeRequest((details, callback) => {
      const block =
        this.getSettings().blockImagesInBackground &&
        (details.resourceType === 'image' || details.resourceType === 'media') &&
        typeof details.webContentsId === 'number' &&
        hiddenContents.has(details.webContentsId);
      callback(block ? { cancel: true } : {});
    });
  }

  private proxyFor(index: number): ProxyEntry | undefined {
    if (this.proxyList.length === 0) return undefined;
    return this.proxyList[index % this.proxyList.length];
  }

  private async applyProxy(handle: SessionHandle, proxy: ProxyEntry | undefined): Promise<void> {
    if (proxy) {
      handle.proxy = proxy;
      await handle.session.setProxy({ proxyRules: proxyRules(proxy), proxyBypassRules: '<local>' });
    } else {
      delete handle.proxy;
      await handle.session.setProxy({ mode: 'direct' });
    }
    await handle.session.closeAllConnections();
  }

  private syncProxyList(text: string): boolean {
    if (text === this.proxyText) return false;
    this.proxyText = text;
    this.proxyList = parseProxyList(text).proxies;
    return true;
  }

  /** Re-assign proxies after the list changes in Settings. */
  async onSettingsChanged(settings: Settings): Promise<void> {
    if (!this.syncProxyList(settings.proxies)) return;
    let index = 0;
    for (const handle of this.handles.values()) await this.applyProxy(handle, this.proxyFor(index++));
  }

  /** Proxy credentials for a session, used to answer proxy auth prompts in windows. */
  proxyForSession(ses: Session): ProxyEntry | undefined {
    for (const handle of this.handles.values()) if (handle.session === ses) return handle.proxy;
    return undefined;
  }

  /** Sign an account out of this app by wiping its isolated profile. */
  async clearAccount(accountId: string): Promise<void> {
    const ses = session.fromPartition(`persist:acct-${accountId}`);
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.clearAuthCache();
  }
}
