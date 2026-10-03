// The browser fallback: a hidden Chromium window bound to an account's isolated session.
// It is never shown unless the user asks (Open window), never takes focus on its own,
// and is driven with DOM events inside the page only.
import { BrowserWindow, Menu, type WebFrameMain } from 'electron';
import { classifyPage, type Detection } from './detection';
import { AbortedError, RetailerError, sleep } from './errors';
import { emptyFillReport, mergeFillReports, pageFillForms, type FillReport, type FillRequest } from './fillScripts';
import {
  pageCardEntryVisible,
  pageClick,
  pageExists,
  pageFill,
  pageFormFields,
  pageFrameClick,
  pageFrameText,
  pageReadText,
  pageSelectCard,
  pageSelectValue,
  pageSnapshot,
  type CardSelection,
  type ClickTarget,
  type PageSnapshot,
} from './pageScripts';
import { setContentsHidden, type SessionHandle } from './sessions';

/** Our helpers run in this isolated JavaScript world, invisible to the page's own scripts. */
const WORLD_ID = 1337;

export interface WaitOptions {
  timeoutMs: number;
  intervalMs?: number;
  signal: AbortSignal;
}

export class BrowserPage {
  private disposed = false;
  private visible = false;
  private readonly contentsId: number;
  private readonly closeListeners = new Set<() => void>();

  private constructor(
    readonly win: BrowserWindow,
    readonly handle: SessionHandle,
  ) {
    this.contentsId = win.webContents.id;
  }

  static open(handle: SessionHandle, title: string, show: boolean): BrowserPage {
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      title,
      autoHideMenuBar: true,
      skipTaskbar: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        session: handle.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
        // Hidden windows must keep full-speed timers, and alert()/confirm() must not block them.
        backgroundThrottling: false,
        disableDialogs: true,
      },
    });
    const page = new BrowserPage(win, handle);
    const wc = win.webContents;
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-prevent-unload', (event) => event.preventDefault());
    wc.on('login', (event, _details, authInfo, callback) => {
      const proxy = handle.proxy;
      if (authInfo.isProxy && proxy?.username) {
        event.preventDefault();
        callback(proxy.username, proxy.password ?? '');
      }
    });
    win.on('page-title-updated', (event) => {
      event.preventDefault();
    });
    // Closing a window the user opened only hides it, so the task keeps its place.
    win.on('close', (event) => {
      if (page.disposed) return;
      event.preventDefault();
      page.hide();
      for (const listener of page.closeListeners) listener();
    });
    win.on('closed', () => setContentsHidden(page.contentsId, false));
    setContentsHidden(page.contentsId, true);
    if (show) page.show();
    return page;
  }

  get alive(): boolean {
    return !this.disposed && !this.win.isDestroyed();
  }

  get isVisible(): boolean {
    return this.visible;
  }

  url(): string {
    return this.alive ? this.win.webContents.getURL() : '';
  }

  onUserClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  show(): void {
    if (!this.alive) return;
    this.visible = true;
    setContentsHidden(this.contentsId, false);
    const wc = this.win.webContents;
    this.win.setMenu(
      Menu.buildFromTemplate([
        {
          label: 'Page',
          submenu: [
            { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => wc.reload() },
            { label: 'Back', accelerator: 'Alt+Left', click: () => wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack() },
            { label: 'Forward', accelerator: 'Alt+Right', click: () => wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward() },
            { type: 'separator' },
            { label: 'Hide window', accelerator: 'CmdOrCtrl+W', click: () => this.hide() },
          ],
        },
      ]),
    );
    this.win.setSkipTaskbar(false);
    this.win.show();
    this.win.focus();
  }

  hide(): void {
    if (!this.alive) return;
    this.visible = false;
    this.win.hide();
    this.win.setSkipTaskbar(true);
    setContentsHidden(this.contentsId, true);
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closeListeners.clear();
    setContentsHidden(this.contentsId, false);
    if (!this.win.isDestroyed()) this.win.destroy();
  }

  async goto(url: string, signal: AbortSignal, timeoutMs = 45_000): Promise<void> {
    if (!this.alive) throw new RetailerError('Browser window was closed');
    const loaded = this.waitForLoad(timeoutMs, signal);
    // ERR_ABORTED is normal when a page redirects itself; waitForLoad decides the outcome.
    this.win.webContents.loadURL(url).catch(() => undefined);
    await loaded;
  }

  async reload(signal: AbortSignal, timeoutMs = 45_000): Promise<void> {
    const loaded = this.waitForLoad(timeoutMs, signal);
    this.win.webContents.reload();
    await loaded;
  }

  private waitForLoad(timeoutMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const wc = this.win.webContents;
      const cleanup = () => {
        clearTimeout(timer);
        wc.off('did-stop-loading', onStop);
        wc.off('did-fail-load', onFail);
        signal.removeEventListener('abort', onAbort);
      };
      const onStop = () => {
        cleanup();
        resolve();
      };
      const onFail = (_e: unknown, code: number, description: string, _url: string, isMainFrame: boolean) => {
        if (!isMainFrame || code === -3) return;
        cleanup();
        reject(new RetailerError(`Page failed to load (${description || code})`));
      };
      const onAbort = () => {
        cleanup();
        reject(new AbortedError());
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new RetailerError(`Page took longer than ${Math.round(timeoutMs / 1000)}s to load`));
      }, timeoutMs);
      wc.on('did-stop-loading', onStop);
      wc.on('did-fail-load', onFail);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Runs a self-contained function inside the page's isolated world. */
  async evaluate<A extends unknown[], R>(fn: (...args: A) => R, ...args: A): Promise<R> {
    if (!this.alive) throw new RetailerError('Browser window was closed');
    const code = `(${fn.toString()})(...${JSON.stringify(args)})`;
    return (await this.win.webContents.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }])) as R;
  }

  /** Like evaluate, but returns `fallback` if the page navigated mid-call. */
  async tryEvaluate<A extends unknown[], R>(fallback: R, fn: (...args: A) => R, ...args: A): Promise<R> {
    try {
      return await this.evaluate(fn, ...args);
    } catch {
      return fallback;
    }
  }

  snapshot(): Promise<PageSnapshot> {
    return this.tryEvaluate<[], PageSnapshot>(
      { url: this.url(), title: '', text: '', html: '', visibleCaptcha: null },
      pageSnapshot,
    );
  }

  /** What kind of page is showing right now (normal, queue, CAPTCHA, challenge, block). */
  async detect(): Promise<Detection & { snapshot: PageSnapshot }> {
    const snapshot = await this.snapshot();
    if (snapshot.visibleCaptcha) {
      return { kind: 'captcha', detail: `CAPTCHA shown (${snapshot.visibleCaptcha})`, provider: snapshot.visibleCaptcha, snapshot };
    }
    return { ...classifyPage({ url: snapshot.url, text: snapshot.text, html: snapshot.html, source: 'dom' }), snapshot };
  }

  click(target: ClickTarget): Promise<{ clicked: boolean; label: string }> {
    return this.tryEvaluate({ clicked: false, label: '' }, pageClick, target);
  }

  fill(selectors: string[], value: string): Promise<boolean> {
    return this.tryEvaluate(false, pageFill, selectors, value);
  }

  exists(selectors: string[]): Promise<boolean> {
    return this.tryEvaluate(false, pageExists, selectors);
  }

  readText(selectors: string[]): Promise<string | null> {
    return this.tryEvaluate<[string[]], string | null>(null, pageReadText, selectors);
  }

  /**
   * 'card' or 'cvv' when a payment form is waiting for card data. `includeFrames` also counts a
   * payment processor's card iframe (its contents cannot be checked from the page).
   */
  cardEntryVisible(includeFrames = true): Promise<'cvv' | 'card' | null> {
    return this.tryEvaluate<[boolean], 'cvv' | 'card' | null>(null, pageCardEntryVisible, includeFrames);
  }

  /** Child frames (not the page itself) whose origin `allow` accepts. */
  private childFrames(allow: (origin: string) => boolean): WebFrameMain[] {
    if (!this.alive) return [];
    const main = this.win.webContents.mainFrame;
    return main.framesInSubtree.filter(
      (frame) => frame.frameTreeNodeId !== main.frameTreeNodeId && !frame.isDestroyed() && !frame.detached && allow(frame.origin),
    );
  }

  /** Runs a page function in a child frame's own context; null if it navigated or did not answer. */
  private async inFrame<A extends unknown[], R>(frame: WebFrameMain, fn: (...args: A) => R, ...args: A): Promise<R | null> {
    const code = `(${fn.toString()})(...${JSON.stringify(args)})`;
    let timer: NodeJS.Timeout | undefined;
    try {
      return (await Promise.race([
        frame.executeJavaScript(code) as Promise<R>,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 5000);
        }),
      ])) as R | null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fills empty address fields in the page and, when the request carries a card, card fields
   * in the page and in the child frames `allowCardFrame` accepts (a payment processor's
   * secure fields live in their own frames). Shipping data is only used in the page itself.
   */
  async fillForms(request: FillRequest, allowCardFrame: (origin: string) => boolean): Promise<FillReport> {
    const reports: FillReport[] = [];
    const main = await this.tryEvaluate<[FillRequest], FillReport | null>(null, pageFillForms, request);
    if (main) reports.push(main);
    if (main?.toggledBilling) {
      // The separate billing form renders after "same as shipping" is unticked.
      await sleep(700);
      const again = await this.tryEvaluate<[FillRequest], FillReport | null>(null, pageFillForms, { ...request, separateBilling: false });
      if (again) reports.push(again);
    }
    if (request.card) {
      const frameRequest: FillRequest = { ...request, shipping: null, separateBilling: false, defaultSection: 'billing' };
      for (const frame of this.childFrames(allowCardFrame)) {
        const report = await this.inFrame(frame, pageFillForms, frameRequest);
        if (report) reports.push(report);
      }
    }
    return reports.length ? mergeFillReports(reports) : emptyFillReport();
  }

  /** Clicks inside the allowed child frames only (e.g. the "Add your card" button of a store's card dialog). */
  async clickInChildFrames(target: ClickTarget, allow: (origin: string) => boolean): Promise<{ clicked: boolean; label: string }> {
    for (const frame of this.childFrames(allow)) {
      const result = await this.inFrame(frame, pageClick, target);
      if (result?.clicked) return result;
    }
    return { clicked: false, label: '' };
  }

  selectCard(last4: string): Promise<CardSelection> {
    return this.tryEvaluate({ found: false, selected: false, label: '' }, pageSelectCard, last4);
  }

  selectValue(selectors: string[], value: string): Promise<boolean> {
    return this.tryEvaluate(false, pageSelectValue, selectors, value);
  }

  frameText(frameSelector: string): Promise<string> {
    return this.tryEvaluate('', pageFrameText, frameSelector);
  }

  frameClick(frameSelector: string, selectors: string[]): Promise<boolean> {
    return this.tryEvaluate(false, pageFrameClick, frameSelector, selectors);
  }

  formFields(selector: string): Promise<{ action: string; fields: Array<[string, string]> } | null> {
    return this.tryEvaluate<[string], { action: string; fields: Array<[string, string]> } | null>(null, pageFormFields, selector);
  }

  /** Gives a click time to start a navigation, then waits until the page stops loading. */
  async settle(signal: AbortSignal, minMs = 1200, maxMs = 20_000): Promise<void> {
    await sleep(minMs, signal);
    const deadline = Date.now() + maxMs;
    while (this.alive && this.win.webContents.isLoading() && Date.now() < deadline) await sleep(250, signal);
  }

  /** Polls `probe` until it returns a truthy value. Returns null on timeout. */
  async waitFor<T>(probe: () => Promise<T | null | undefined | false>, options: WaitOptions): Promise<T | null> {
    const deadline = Date.now() + options.timeoutMs;
    for (;;) {
      if (options.signal.aborted) throw new AbortedError();
      if (!this.alive) throw new RetailerError('Browser window was closed');
      const value = await probe();
      if (value) return value;
      if (Date.now() >= deadline) return null;
      await sleep(options.intervalMs ?? 300, options.signal);
    }
  }

  /** Waits for a click target to appear and clicks it. */
  async clickWhenReady(target: ClickTarget, options: WaitOptions): Promise<string | null> {
    const result = await this.waitFor(async () => {
      const r = await this.click(target);
      return r.clicked ? r.label || 'clicked' : null;
    }, options);
    return result;
  }
}
