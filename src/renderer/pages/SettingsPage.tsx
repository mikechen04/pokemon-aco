import { Bell, BookOpen, Download, FileJson, FolderOpen, Gauge, Globe, OctagonX, RefreshCw, Send, ShieldCheck, Store } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { CATALOG_FEED_URL, DEFAULT_NOTIFY_ON, LIMITS } from '../../shared/constants';
import { parseProxyList } from '../../shared/proxies';
import { RETAILER_LIST } from '../../shared/retailers';
import { firstIssue, settingsPatchSchema } from '../../shared/schemas';
import type { NotifyOn, ProxyTestResult, Settings, SettingsPatch } from '../../shared/types';
import { call } from '../api';
import { installUpdate, PageHeader, setDryRun } from '../App';
import { Button, Field, ToggleRow } from '../components/ui';
import { act, useApp } from '../store';

const NOTIFY_LABELS: Record<keyof NotifyOn, string> = {
  inStock: 'In stock',
  queue: 'Waiting room (queue) holding a task',
  carted: 'Carted',
  checkedOut: 'Checked out',
  paused: 'Paused (challenge, sign-in, review needed)',
  failed: 'Failed / auto-stopped',
};

type Draft = Omit<Settings, 'killSwitch' | 'dryRun'>;

function toDraft(s: Settings): Draft {
  const { killSwitch: _k, dryRun: _d, ...rest } = s;
  return rest;
}

export function SettingsPage() {
  const settings = useApp((s) => s.settings);
  const info = useApp((s) => s.info);
  const appUpdate = useApp((s) => s.appUpdate);
  const running = useApp((s) => s.tasks.filter((t) => t.runtime.running).length);
  const [draft, setDraft] = useState<Draft | null>(settings ? toDraft(settings) : null);
  const [showSecret, setShowSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proxyResults, setProxyResults] = useState<ProxyTestResult[] | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (settings && !draft) setDraft(toDraft(settings));
  }, [settings, draft]);

  const dirty = useMemo(() => Boolean(settings && draft && JSON.stringify(toDraft(settings)) !== JSON.stringify(draft)), [settings, draft]);
  const proxyCheck = useMemo(() => parseProxyList(draft?.proxies ?? ''), [draft?.proxies]);

  if (!settings || !draft) return null;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft({ ...draft, [key]: value });
  const num = (key: 'maxConcurrency' | 'maxQuantityPerTask' | 'maxConsecutiveFailures' | 'sessionKeepAliveMinutes') => (e: { target: { value: string } }) =>
    set(key, Number.parseInt(e.target.value.replace(/\D/g, '') || '0', 10));

  const save = async () => {
    const patch: SettingsPatch = { ...draft };
    const check = settingsPatchSchema.safeParse(patch);
    if (!check.success) return setError(firstIssue(check.error));
    setError(null);
    const next = await act(call('settings:update', patch), 'Settings saved');
    if (next) setDraft(toDraft(next));
  };

  const testProxies = async () => {
    if (dirty) await save();
    setTesting(true);
    const results = await act(call('settings:testProxies'));
    setTesting(false);
    if (results) setProxyResults(results);
  };

  return (
    <>
      <PageHeader title="Settings" subtitle="Speed, safety limits, notifications and proxies." />
      <div className="page-body">
        <div className="settings-grid">
          <div className="card card-pad">
            <h2>
              <ShieldCheck size={16} style={{ verticalAlign: -2, marginRight: 6 }} color="var(--accent)" />
              Safety
            </h2>
            <p className="hint">Limits that apply to every task, whatever else is configured.</p>
            <ToggleRow
              title="Dry run"
              description="Go through checkout and verify card, address and price, but stop before placing the order. Applies right away."
              on={settings.dryRun}
              onChange={(on) => void setDryRun(on)}
            />
            <div className="toggle-row">
              <div className="text">
                <div className="title">Kill switch</div>
                <div className="desc">Stops every task and closes every automation window immediately. Nothing can start while it is on.</div>
              </div>
              <Button
                small
                variant={settings.killSwitch ? 'primary' : 'danger'}
                onClick={() => void act(call('settings:setKillSwitch', !settings.killSwitch), settings.killSwitch ? 'Kill switch released' : 'Kill switch engaged')}
              >
                <OctagonX size={14} /> {settings.killSwitch ? 'Release' : 'Engage'}
              </Button>
            </div>
            <div className="form-grid" style={{ marginTop: 8 }}>
              <Field label="Max quantity per task" help={`${LIMITS.maxQuantityPerTask.min}–${LIMITS.maxQuantityPerTask.max}`}>
                <input className="input" inputMode="numeric" value={draft.maxQuantityPerTask} onChange={num('maxQuantityPerTask')} />
              </Field>
              <Field label="Auto-stop after failures in a row" help="Stock-check or checkout errors before a task stops itself">
                <input className="input" inputMode="numeric" value={draft.maxConsecutiveFailures} onChange={num('maxConsecutiveFailures')} />
              </Field>
            </div>
            <div className="field-label" style={{ marginTop: 10 }}>Most of one item per account (last 30 days, 0 = no limit)</div>
            <div className="form-grid four">
              {RETAILER_LIST.map((r) => (
                <Field key={r.id} label={r.name}>
                  <input
                    className="input"
                    inputMode="numeric"
                    value={draft.itemLimitPerAccount[r.id]}
                    onChange={(e) =>
                      set('itemLimitPerAccount', { ...draft.itemLimitPerAccount, [r.id]: Number.parseInt(e.target.value.replace(/\D/g, '') || '0', 10) })
                    }
                  />
                </Field>
              ))}
            </div>
            <p className="hint" style={{ marginTop: 4 }}>
              Stores cancel orders over their per-customer limits (Target: 2 of an item). Tasks stop once an account has bought this many,
              counting every order this app placed for it.
            </p>
          </div>

          <div className="card card-pad">
            <h2>
              <Gauge size={16} style={{ verticalAlign: -2, marginRight: 6 }} color="var(--accent)" />
              Monitoring and speed
            </h2>
            <p className="hint">Tasks watching the same product share one stock check per interval.</p>
            <div className="form-grid">
              <Field label="Stock check interval (seconds)" help={`Minimum ${LIMITS.pollIntervalMs.min / 1000}s`}>
                <input
                  className="input"
                  inputMode="decimal"
                  value={draft.pollIntervalMs / 1000}
                  onChange={(e) => set('pollIntervalMs', Math.round((Number.parseFloat(e.target.value) || 0) * 1000))}
                />
              </Field>
              <Field label="Request timeout (seconds)">
                <input
                  className="input"
                  inputMode="numeric"
                  value={draft.requestTimeoutMs / 1000}
                  onChange={(e) => set('requestTimeoutMs', (Number.parseInt(e.target.value.replace(/\D/g, ''), 10) || 0) * 1000)}
                />
              </Field>
              <Field label="Global max concurrency" help="Tasks that may cart and check out at the same time">
                <input className="input" inputMode="numeric" value={draft.maxConcurrency} onChange={num('maxConcurrency')} />
              </Field>
              <Field label="Keep sessions warm every (minutes)" help="0 turns it off">
                <input className="input" inputMode="numeric" value={draft.sessionKeepAliveMinutes} onChange={num('sessionKeepAliveMinutes')} />
              </Field>
            </div>
            <ToggleRow
              title="Skip images in background windows"
              description="Faster page loads in hidden checkout windows. Windows you open show everything."
              on={draft.blockImagesInBackground}
              onChange={(on) => set('blockImagesInBackground', on)}
            />
            <ToggleRow
              title="Show automation windows"
              description="For troubleshooting: checkout windows open visibly instead of hidden. They never take your mouse or keyboard."
              on={draft.showAutomationWindows}
              onChange={(on) => set('showAutomationWindows', on)}
            />
          </div>

          <div className="card card-pad">
            <h2>
              <Bell size={16} style={{ verticalAlign: -2, marginRight: 6 }} color="var(--pink)" />
              Notifications
            </h2>
            <p className="hint">Messages never include passwords, emails or full addresses.</p>
            <ToggleRow title="Desktop notifications" on={draft.desktopNotifications} onChange={(on) => set('desktopNotifications', on)} />
            {(Object.keys(DEFAULT_NOTIFY_ON) as Array<keyof NotifyOn>).map((key) => (
              <ToggleRow key={key} title={NOTIFY_LABELS[key]} on={draft.notifyOn[key]} pink onChange={(on) => set('notifyOn', { ...draft.notifyOn, [key]: on })} />
            ))}
            <Field label="Discord webhook URL (optional)" help="Server Settings → Integrations → Webhooks → Copy URL">
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="input"
                  type={showSecret ? 'text' : 'password'}
                  value={draft.webhookUrl}
                  onChange={(e) => set('webhookUrl', e.target.value.trim())}
                  placeholder="https://discord.com/api/webhooks/…"
                  autoComplete="off"
                />
                <Button small onClick={() => setShowSecret(!showSecret)}>
                  {showSecret ? 'Hide' : 'Show'}
                </Button>
              </div>
            </Field>
            <div className="toolbar" style={{ marginTop: 8 }}>
              <Button
                small
                disabled={!draft.webhookUrl}
                onClick={async () => {
                  if (dirty) await save();
                  const r = await act(call('settings:testWebhook'));
                  if (r) useApp.getState().toast(r.ok ? 'success' : 'error', r.ok ? 'Test message sent to Discord' : r.message);
                }}
              >
                <Send size={13} /> Send test
              </Button>
            </div>
          </div>

          <div className="card card-pad">
            <h2>
              <Globe size={16} style={{ verticalAlign: -2, marginRight: 6 }} color="var(--accent)" />
              Proxies (optional)
            </h2>
            <p className="hint">
              Plain HTTP proxies you provide. Each account and monitor keeps the same proxy; the app never switches proxies to get around a
              block. One per line: host:port, host:port:user:pass or http://user:pass@host:port.
            </p>
            <textarea
              className={`textarea ${proxyCheck.invalid.length ? 'invalid' : ''}`}
              rows={6}
              value={draft.proxies}
              onChange={(e) => set('proxies', e.target.value)}
              spellCheck={false}
              placeholder="203.0.113.10:8080"
            />
            <div className="toolbar" style={{ marginTop: 8 }}>
              <span className={proxyCheck.invalid.length ? 'danger-text' : 'muted'}>
                {proxyCheck.proxies.length} proxy line(s){proxyCheck.invalid.length ? `, ${proxyCheck.invalid.length} invalid` : ''}
              </span>
              <div className="spacer" />
              <Button small disabled={testing || proxyCheck.proxies.length === 0 || proxyCheck.invalid.length > 0} onClick={() => void testProxies()}>
                {testing ? 'Testing…' : 'Test proxies'}
              </Button>
            </div>
            {proxyResults ? (
              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table className="grid">
                  <tbody>
                    {proxyResults.map((r) => (
                      <tr key={r.proxy}>
                        <td>{r.proxy}</td>
                        <td>{r.ok ? <span className="badge ok">OK</span> : <span className="badge danger">Failed</span>}</td>
                        <td className="num">{r.ms} ms</td>
                        <td className="muted">{r.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>

          <div className="card card-pad">
            <h2>
              <Store size={16} style={{ verticalAlign: -2, marginRight: 6 }} color="var(--accent)" />
              Retailers
            </h2>
            <p className="hint">Store-specific options.</p>
            <Field
              label="Best Buy developer API key (optional)"
              help="Free from developer.bestbuy.com. When set, Best Buy stock checks and keyword search use the official API."
            >
              <input
                className="input"
                type={showSecret ? 'text' : 'password'}
                value={draft.bestBuyApiKey}
                onChange={(e) => set('bestBuyApiKey', e.target.value.trim())}
                autoComplete="off"
              />
            </Field>
            <ToggleRow
              title="Amazon: only buy when sold by Amazon.com"
              description="Skips third-party sellers in the buy box (common for marked-up listings)."
              on={draft.amazonSoldByAmazonOnly}
              onChange={(on) => set('amazonSoldByAmazonOnly', on)}
            />
            <div className="toolbar" style={{ marginTop: 6 }}>
              <Button small onClick={() => void act(call('app:openPath', 'overrides'))}>
                <FileJson size={13} /> Open retailer-overrides.json
              </Button>
              <span className="faint" style={{ fontSize: 12 }}>
                Fix a changed endpoint or selector without rebuilding.
              </span>
            </div>
          </div>

          <div className="card card-pad">
            <h2>
              <RefreshCw size={16} style={{ verticalAlign: -2, marginRight: 6 }} color="var(--accent)" />
              App updates
            </h2>
            <p className="hint">
              New versions come from the project’s GitHub Releases. Downloads wait until no task is running, and a downloaded update
              installs when you quit the app.
            </p>
            <div className="kv">
              <span className="k">Installed</span>
              <span className="v">v{appUpdate?.currentVersion ?? info?.version}</span>
              <span className="k">Status</span>
              <span className="v">
                {appUpdate?.message ?? '—'}
                {appUpdate?.state === 'downloading' ? ` (${appUpdate.percent ?? 0}%)` : ''}
              </span>
              {appUpdate?.checkedAt ? (
                <>
                  <span className="k">Last check</span>
                  <span className="v">{new Date(appUpdate.checkedAt).toLocaleString()}</span>
                </>
              ) : null}
            </div>
            <ToggleRow
              title="Download updates automatically"
              description="Off: you are told about a new version and download it yourself."
              on={draft.autoUpdate}
              onChange={(on) => set('autoUpdate', on)}
            />
            <div className="toolbar" style={{ marginTop: 6 }}>
              <Button
                small
                disabled={!appUpdate || ['unsupported', 'checking', 'downloading', 'ready'].includes(appUpdate.state)}
                onClick={() => void act(call('appUpdate:check'))}
              >
                <RefreshCw size={13} /> Check now
              </Button>
              {appUpdate?.state === 'available' ? (
                <Button small onClick={() => void act(call('appUpdate:download'))}>
                  <Download size={13} /> Download {appUpdate.version}
                </Button>
              ) : null}
              {appUpdate?.state === 'ready' ? (
                <Button small variant="primary" onClick={() => void installUpdate(running)}>
                  <Download size={13} /> Restart and install {appUpdate.version}
                </Button>
              ) : null}
            </div>
          </div>

          <div className="card card-pad">
            <h2>
              <BookOpen size={16} style={{ verticalAlign: -2, marginRight: 6 }} color="var(--pink)" />
              Catalog feed
            </h2>
            <p className="hint">
              A list of current Pokémon TCG products with TCGplayer market prices, rebuilt every day by the project’s GitHub workflow.
              Syncing adds new products and refreshes prices; your own entries and edits are kept.
            </p>
            <ToggleRow
              title="Sync the catalog automatically"
              description="Shortly after the app starts, then every 6 hours."
              on={draft.catalogAutoSync}
              pink
              onChange={(on) => set('catalogAutoSync', on)}
            />
            <Field label="Feed URL" help="Change only if you publish your own feed.">
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input" value={draft.catalogFeedUrl} onChange={(e) => set('catalogFeedUrl', e.target.value.trim())} spellCheck={false} />
                <Button small disabled={draft.catalogFeedUrl === CATALOG_FEED_URL} onClick={() => set('catalogFeedUrl', CATALOG_FEED_URL)}>
                  Default
                </Button>
              </div>
            </Field>
          </div>

          <div className="card card-pad">
            <h2>About and data</h2>
            <p className="hint">Everything is stored on this computer only.</p>
            <div className="kv">
              <span className="k">Version</span>
              <span className="v">{info?.version}</span>
              <span className="k">Encryption</span>
              <span className="v">
                {info?.encryption.backend} {info?.encryption.strong ? '(strong)' : '(weak on this system)'}
              </span>
              <span className="k">Data folder</span>
              <span className="v">{info?.paths.userData}</span>
              <span className="k">Logs</span>
              <span className="v">{info?.paths.logs}</span>
            </div>
            <div className="toolbar" style={{ marginTop: 12 }}>
              <Button small onClick={() => void act(call('app:openPath', 'userData'))}>
                <FolderOpen size={13} /> Data folder
              </Button>
              <Button small onClick={() => void act(call('app:openPath', 'logs'))}>
                <FolderOpen size={13} /> Logs
              </Button>
            </div>
          </div>
        </div>

        {dirty || error ? (
          <div className="save-bar">
            <div className="grow">{error ? <span className="danger-text">{error}</span> : 'You have unsaved changes.'}</div>
            <Button
              onClick={() => {
                setDraft(toDraft(settings));
                setError(null);
              }}
            >
              Discard
            </Button>
            <Button variant="primary" onClick={() => void save()}>
              Save changes
            </Button>
          </div>
        ) : null}
      </div>
    </>
  );
}
