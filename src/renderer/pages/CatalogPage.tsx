import { BookOpen, CloudDownload, Download, ExternalLink, FileJson, Flame, Pencil, Plus, RefreshCw, Search, Trash2, TrendingDown, TrendingUp, Upload, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CATALOG_SORTS, catalogMargin, formatChange, hasStoreLink, hotThreshold, isHot, sortCatalog, type CatalogSort } from '../../shared/catalog';
import { CATALOG_CATEGORIES } from '../../shared/constants';
import { formatUsd } from '../../shared/money';
import { parseProductInput, RETAILER_LIST, RETAILERS } from '../../shared/retailers';
import { catalogEntryProblems, catalogEntrySchema, firstIssue } from '../../shared/schemas';
import { RETAILER_IDS, type CatalogEntry, type RetailerId } from '../../shared/types';
import { call } from '../api';
import { PageHeader } from '../App';
import { Button, confirm, EmptyState, Field, IconButton, Modal } from '../components/ui';
import { act, useApp } from '../store';

function slugify(text: string): string {
  return (
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'entry'
  );
}

function hasLink(entry: CatalogEntry, id: RetailerId): boolean {
  return Boolean(entry.retailers[id].url || entry.retailers[id].sku);
}

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'unknown';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 2) return 'just now';
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function formatDay(day: string): string {
  const date = new Date(`${day}T12:00:00`);
  return Number.isNaN(date.getTime()) ? day : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function PriceLine({ entry }: { entry: CatalogEntry }) {
  const margin = catalogMargin(entry);
  const change = entry.market?.change7d ?? null;
  if (!entry.market?.price && !entry.msrp) return null;
  return (
    <div className="price-line">
      <div>
        <span className="k">MSRP</span>
        <span className="v" title={entry.msrpEstimated ? 'Usual retail price for this kind of product' : undefined}>
          {entry.msrp ? `${entry.msrpEstimated ? '≈' : ''}${formatUsd(entry.msrp)}` : '—'}
        </span>
      </div>
      <div>
        <span className="k">Market</span>
        <span className="v">{formatUsd(entry.market?.price)}</span>
      </div>
      <div>
        <span className="k">Margin</span>
        <span className={`v ${margin ? (margin.amount >= 0 ? 'up' : 'down') : ''}`}>
          {margin ? `${margin.amount >= 0 ? '+' : '−'}${formatUsd(Math.abs(margin.amount))} (${formatChange(margin.pct)})` : '—'}
        </span>
      </div>
      <div>
        <span className="k">7 days</span>
        <span className={`v ${change === null ? '' : change >= 0 ? 'up' : 'down'}`}>
          {change === null ? '—' : (
            <>
              {change >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />} {formatChange(change)}
            </>
          )}
        </span>
      </div>
    </div>
  );
}

export function CatalogPage() {
  const catalog = useApp((s) => s.catalog);
  const settings = useApp((s) => s.settings);
  const requestTaskDraft = useApp((s) => s.requestTaskDraft);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [sort, setSort] = useState<CatalogSort>('hot');
  const [linkedOnly, setLinkedOnly] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [editing, setEditing] = useState<CatalogEntry | 'new' | null>(null);
  // Images that failed to load (offline, or the CDN refused) show the placeholder icon instead.
  const [brokenImages, setBrokenImages] = useState<Set<string>>(() => new Set());
  const entries = catalog?.entries ?? [];
  const feed = catalog?.feed;

  const categories = useMemo(() => [...new Set(entries.map((e) => e.category))].sort(), [entries]);
  const hotScore = useMemo(() => hotThreshold(entries), [entries]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = entries.filter((e) => {
      if (category !== 'all' && e.category !== category) return false;
      if (linkedOnly && !hasStoreLink(e)) return false;
      return !q || `${e.name} ${e.set} ${e.category} ${e.tags.join(' ')} ${e.notes}`.toLowerCase().includes(q);
    });
    return sortCatalog(filtered, sort);
  }, [entries, category, linkedOnly, query, sort]);

  const syncNow = async () => {
    setSyncing(true);
    const result = await act(call('catalog:sync'));
    setSyncing(false);
    if (result) useApp.getState().toast(result.ok ? 'success' : 'warn', result.message);
  };

  const importCatalog = async (mode: 'merge' | 'replace') => {
    if (mode === 'replace') {
      const ok = await confirm({ title: 'Replace the whole catalog?', message: 'Every current entry is removed and replaced by the file’s entries.', confirmLabel: 'Choose file', danger: true });
      if (!ok) return;
    }
    const result = await act(call('catalog:import', mode));
    if (result) useApp.getState().toast(result.ok ? 'success' : 'warn', result.message);
  };

  const remove = async (entry: CatalogEntry) => {
    const message = entry.origin === 'feed' ? 'Tasks created from it keep working, and sync will not add it back.' : 'Tasks created from it keep working.';
    const ok = await confirm({ title: `Delete "${entry.name}"?`, message, confirmLabel: 'Delete', danger: true });
    if (ok) await act(call('catalog:remove', entry.id), 'Entry deleted');
  };

  return (
    <>
      <PageHeader
        title="Catalog"
        subtitle="Pokémon TCG products to make tasks from, with resale prices. Kept up to date automatically."
        actions={
          <>
            <Button onClick={() => void syncNow()} disabled={syncing}>
              <CloudDownload size={15} /> {syncing ? 'Syncing…' : 'Sync now'}
            </Button>
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus size={16} /> Add entry
            </Button>
            <Button onClick={() => void importCatalog('merge')}>
              <Upload size={14} /> Import
            </Button>
            <Button onClick={() => void act(call('catalog:export')).then((r) => r && useApp.getState().toast(r.ok ? 'success' : 'info', r.message))}>
              <Download size={14} /> Export
            </Button>
          </>
        }
      />
      <div className="page-body">
        <div className="banner pink">
          <BookOpen size={18} color="var(--pink)" />
          <div className="grow">
            {feed ? (
              <>
                Synced {timeAgo(feed.syncedAt)} · prices from {timeAgo(feed.generatedAt)} ({feed.source || 'catalog feed'}).
              </>
            ) : settings?.catalogAutoSync ? (
              <>Not synced yet. The catalog downloads current products and TCGplayer prices shortly after the app starts.</>
            ) : (
              <>Automatic catalog sync is off (Settings). Press Sync now to download current products and prices.</>
            )}{' '}
            Margin is the TCGplayer market price minus MSRP (≈ marks a usual price for the product type). Store links come from
            the feed when known; add your own with <b>Edit</b>. Sync keeps your changes.
          </div>
        </div>
        <div className="toolbar">
          <div className="search">
            <Search size={15} />
            <input className="input" placeholder="Search catalog" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <select className="select" style={{ width: 200 }} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="all">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select className="select" style={{ width: 170 }} value={sort} onChange={(e) => setSort(e.target.value as CatalogSort)} aria-label="Sort">
            {(Object.keys(CATALOG_SORTS) as CatalogSort[]).map((key) => (
              <option key={key} value={key}>
                {CATALOG_SORTS[key]}
              </option>
            ))}
          </select>
          <label className="check-chip">
            <input type="checkbox" checked={linkedOnly} onChange={(e) => setLinkedOnly(e.target.checked)} /> Has store links
          </label>
          <div className="spacer" />
          <Button small onClick={() => void act(call('app:openPath', 'catalog'))}>
            <FileJson size={14} /> Open catalog.json
          </Button>
          <Button small onClick={() => void act(call('catalog:reload'), 'Catalog reloaded from disk')}>
            <RefreshCw size={13} /> Reload
          </Button>
          <Button small variant="danger" onClick={() => void importCatalog('replace')}>
            Replace from file
          </Button>
        </div>
        {entries.length === 0 ? (
          <div className="card">
            <EmptyState icon={<BookOpen size={22} />} title="The catalog is empty">
              <div>Sync to download current products and prices, or add an entry by hand.</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button onClick={() => void syncNow()} disabled={syncing}>
                  <CloudDownload size={15} /> Sync now
                </Button>
                <Button variant="primary" onClick={() => setEditing('new')}>
                  <Plus size={16} /> Add entry
                </Button>
              </div>
            </EmptyState>
          </div>
        ) : visible.length === 0 ? (
          <div className="card">
            <EmptyState icon={<Search size={22} />} title="Nothing matches these filters" />
          </div>
        ) : (
          <div className="card-grid">
            {visible.map((entry) => {
              const linked = RETAILER_IDS.filter((id) => hasLink(entry, id));
              const upcoming = entry.releaseDate && entry.releaseDate > new Date().toISOString().slice(0, 10);
              return (
                <div key={entry.id} className="item-card">
                  <div className="top">
                    <div className="thumb" style={{ width: 54, height: 54 }}>
                      {entry.imageUrl && !brokenImages.has(entry.imageUrl) ? (
                        <img
                          src={entry.imageUrl}
                          alt=""
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          onError={() => setBrokenImages((prev) => new Set(prev).add(entry.imageUrl))}
                        />
                      ) : (
                        <BookOpen size={18} />
                      )}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="title">
                        {entry.name}
                        {isHot(entry, hotScore) ? (
                          <span className="badge pink hot" title="Top 15% of the catalog by resale margin and price trend, or up 15%+ this week">
                            <Flame size={11} /> Hot
                          </span>
                        ) : null}
                      </div>
                      <div className="meta">
                        {entry.category}
                        {entry.set ? ` · ${entry.set}` : ''}
                        {entry.releaseDate ? ` · ${upcoming ? 'releases' : 'released'} ${formatDay(entry.releaseDate)}` : ''}
                      </div>
                    </div>
                  </div>
                  <PriceLine entry={entry} />
                  <div className="row">
                    {RETAILER_LIST.map((r) => (
                      <span
                        key={r.id}
                        className={`badge ${hasLink(entry, r.id) ? 'retailer' : ''}`}
                        style={hasLink(entry, r.id) ? { ['--c' as string]: r.color } : { opacity: 0.55 }}
                        title={hasLink(entry, r.id) ? 'Link filled in' : 'No link yet'}
                      >
                        {r.name}
                      </span>
                    ))}
                  </div>
                  {entry.notes ? (
                    <div className="meta" style={{ fontSize: 12 }}>
                      {entry.notes}
                    </div>
                  ) : null}
                  <div className="foot">
                    <Button small variant="primary" disabled={linked.length === 0} onClick={() => requestTaskDraft(entry.id)} title={linked.length === 0 ? 'Add a store link first' : 'Create a task from this entry'}>
                      <Zap size={13} /> Create task
                    </Button>
                    <Button small onClick={() => setEditing(entry)}>
                      <Pencil size={13} /> Edit
                    </Button>
                    {entry.tcgplayerUrl ? (
                      <IconButton label="TCGplayer prices" onClick={() => void act(call('app:openProductUrl', entry.tcgplayerUrl))}>
                        <ExternalLink size={14} />
                      </IconButton>
                    ) : null}
                    <div style={{ flex: 1 }} />
                    {entry.origin === 'feed' ? <span className="faint" style={{ fontSize: 11.5 }}>auto</span> : null}
                    <IconButton label="Delete" onClick={() => void remove(entry)}>
                      <Trash2 size={14} />
                    </IconButton>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {editing ? <CatalogForm entry={editing === 'new' ? null : editing} existingIds={entries.map((e) => e.id)} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function blankEntry(): CatalogEntry {
  return {
    id: '',
    name: '',
    category: 'Elite Trainer Box',
    set: '',
    tags: [],
    imageUrl: '',
    msrp: null,
    msrpEstimated: false,
    notes: '',
    releaseDate: '',
    tcgplayerId: null,
    tcgplayerUrl: '',
    market: null,
    score: null,
    origin: 'user',
    retailers: {
      target: { url: '', sku: '' },
      bestbuy: { url: '', sku: '' },
      amazon: { url: '', sku: '' },
      pokemoncenter: { url: '', sku: '' },
    },
  };
}

function CatalogForm({ entry, existingIds, onClose }: { entry: CatalogEntry | null; existingIds: string[]; onClose: () => void }) {
  const [draft, setDraft] = useState<CatalogEntry>(entry ?? blankEntry());
  const [tags, setTags] = useState((entry?.tags ?? []).join(', '));
  const [msrp, setMsrp] = useState(entry?.msrp != null ? String(entry.msrp) : '');
  const [error, setError] = useState<string | null>(null);

  const setRef = (id: RetailerId, key: 'url' | 'sku', value: string) =>
    setDraft({ ...draft, retailers: { ...draft.retailers, [id]: { ...draft.retailers[id], [key]: value } } });

  const save = async () => {
    let id = entry?.id ?? slugify(draft.name);
    if (!entry) {
      const base = id;
      for (let n = 2; existingIds.includes(id); n++) id = `${base}-${n}`;
    }
    const nextMsrp = msrp.trim() ? Number(msrp) : null;
    const candidate: CatalogEntry = {
      ...draft,
      id,
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      msrp: nextMsrp,
      // A price typed in by hand is a confirmed one.
      msrpEstimated: nextMsrp !== null && nextMsrp === draft.msrp ? draft.msrpEstimated : false,
    };
    const check = catalogEntrySchema.safeParse(candidate);
    if (!check.success) return setError(firstIssue(check.error));
    const problems = catalogEntryProblems(check.data);
    if (problems.length) return setError(problems[0] ?? 'Invalid link');
    setError(null);
    const result = await act(call('catalog:upsert', check.data), entry ? 'Entry saved' : 'Entry added');
    if (result) onClose();
  };

  return (
    <Modal
      title={entry ? `Edit ${entry.name}` : 'Add catalog entry'}
      icon={<BookOpen size={18} color="var(--accent)" />}
      onClose={onClose}
      footer={
        <>
          <div className="grow">
            {error ? (
              <span className="danger-text">{error}</span>
            ) : entry?.origin === 'feed' ? (
              'From the catalog feed. Whatever you change here is kept when it syncs.'
            ) : (
              'Only use links and SKUs you copied from the store.'
            )}
          </div>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}>
            Save entry
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Product name" className="span-all">
          <input className="input" value={draft.name} maxLength={160} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Exact product name" />
        </Field>
        <Field label="Category">
          <input className="input" list="catalog-categories" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} />
          <datalist id="catalog-categories">
            {CATALOG_CATEGORIES.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>
        <Field label="Set / series">
          <input className="input" value={draft.set} maxLength={80} onChange={(e) => setDraft({ ...draft, set: e.target.value })} />
        </Field>
        <Field label="Tags" help="Comma separated">
          <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} />
        </Field>
        <Field label="MSRP (optional)" help="Pre-fills a task’s max price">
          <div className="prefix-input">
            <span>$</span>
            <input className="input" inputMode="decimal" value={msrp} onChange={(e) => setMsrp(e.target.value.replace(/[^\d.]/g, ''))} />
          </div>
        </Field>
        <Field label="Image URL (optional)" className="span-all">
          <input className="input" value={draft.imageUrl} onChange={(e) => setDraft({ ...draft, imageUrl: e.target.value })} placeholder="https://" />
        </Field>
        <Field label="Notes" className="span-all">
          <input className="input" value={draft.notes} maxLength={1000} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
        </Field>
      </div>
      <div className="section-title">Store links</div>
      {RETAILER_LIST.map((r) => {
        const value = draft.retailers[r.id].url || draft.retailers[r.id].sku;
        const parsed = value ? parseProductInput(r.id, value) : null;
        return (
          <div key={r.id} className="form-grid" style={{ gridTemplateColumns: '2fr 1fr' }}>
            <Field
              label={`${r.name} product URL`}
              error={parsed && !parsed.ok ? parsed.error : null}
              ok={parsed && parsed.ok ? `${RETAILERS[r.id].productIdLabel} ${parsed.product.productId}` : null}
            >
              <input className="input" value={draft.retailers[r.id].url} onChange={(e) => setRef(r.id, 'url', e.target.value)} placeholder={r.inputHint} />
            </Field>
            <Field label={`${r.productIdLabel} (if no URL)`}>
              <input className="input" value={draft.retailers[r.id].sku} onChange={(e) => setRef(r.id, 'sku', e.target.value)} disabled={r.id === 'pokemoncenter'} placeholder={r.id === 'pokemoncenter' ? 'Use the URL' : ''} />
            </Field>
          </div>
        );
      })}
    </Modal>
  );
}
