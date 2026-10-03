import { BookOpen, Download, FileJson, Pencil, Plus, RefreshCw, Search, Trash2, Upload, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
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

export function CatalogPage() {
  const catalog = useApp((s) => s.catalog);
  const requestTaskDraft = useApp((s) => s.requestTaskDraft);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [editing, setEditing] = useState<CatalogEntry | 'new' | null>(null);
  const entries = catalog?.entries ?? [];

  const categories = useMemo(() => [...new Set(entries.map((e) => e.category))].sort(), [entries]);
  const visible = entries.filter((e) => {
    if (category !== 'all' && e.category !== category) return false;
    const q = query.trim().toLowerCase();
    return !q || `${e.name} ${e.set} ${e.category} ${e.tags.join(' ')} ${e.notes}`.toLowerCase().includes(q);
  });

  const importCatalog = async (mode: 'merge' | 'replace') => {
    if (mode === 'replace') {
      const ok = await confirm({ title: 'Replace the whole catalog?', message: 'Every current entry is removed and replaced by the file’s entries.', confirmLabel: 'Choose file', danger: true });
      if (!ok) return;
    }
    const result = await act(call('catalog:import', mode));
    if (result) useApp.getState().toast(result.ok ? 'success' : 'warn', result.message);
  };

  const remove = async (entry: CatalogEntry) => {
    const ok = await confirm({ title: `Delete "${entry.name}"?`, message: 'Tasks created from it keep working.', confirmLabel: 'Delete', danger: true });
    if (ok) await act(call('catalog:remove', entry.id), 'Entry deleted');
  };

  return (
    <>
      <PageHeader
        title="Catalog"
        subtitle="Your index of products to pick from when making tasks. Stored as an editable catalog.json."
        actions={
          <>
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
            Entries ship as placeholders with no SKUs or links. Fill in each store’s product URL (or SKU / TCIN / ASIN) when a
            listing goes live, then use <b>Create task</b>.
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
              <Button variant="primary" onClick={() => setEditing('new')}>
                <Plus size={16} /> Add entry
              </Button>
            </EmptyState>
          </div>
        ) : (
          <div className="card-grid">
            {visible.map((entry) => {
              const linked = RETAILER_IDS.filter((id) => hasLink(entry, id));
              return (
                <div key={entry.id} className="item-card">
                  <div className="top">
                    <div className="thumb" style={{ width: 46, height: 46 }}>
                      {entry.imageUrl ? <img src={entry.imageUrl} alt="" /> : <BookOpen size={18} />}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="title">{entry.name}</div>
                      <div className="meta">
                        {entry.category}
                        {entry.set ? ` · ${entry.set}` : ''}
                        {entry.msrp ? ` · MSRP ${formatUsd(entry.msrp)}` : ''}
                      </div>
                    </div>
                  </div>
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
                    <div style={{ flex: 1 }} />
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
    notes: '',
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
    const candidate: CatalogEntry = {
      ...draft,
      id,
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      msrp: msrp.trim() ? Number(msrp) : null,
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
          <div className="grow">{error ? <span className="danger-text">{error}</span> : 'Only use links and SKUs you copied from the store.'}</div>
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
