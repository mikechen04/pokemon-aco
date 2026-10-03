import { Cookie, Eye, EyeOff, FileUp, KeyRound, LogIn, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, Users } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MAX_BULK_ACCOUNTS, parseAccountLines } from '../../shared/accountLines';
import { RETAILER_LIST, RETAILERS } from '../../shared/retailers';
import { accountInputSchema, firstIssue } from '../../shared/schemas';
import type { AccountInput, AccountPublic, RetailerId } from '../../shared/types';
import { call } from '../api';
import { PageHeader } from '../App';
import { Button, confirm, EmptyState, Field, IconButton, Modal, RetailerBadge } from '../components/ui';
import { act, useApp } from '../store';

const SESSION: Record<AccountPublic['session'], { label: string; cls: string }> = {
  unknown: { label: 'Not checked', cls: '' },
  checking: { label: 'Checking…', cls: 'accent' },
  signed_in: { label: 'Signed in', cls: 'ok' },
  signed_out: { label: 'Signed out', cls: 'warn' },
  needs_attention: { label: 'Needs you', cls: 'danger' },
};

function timeAgo(ts?: number): string {
  if (!ts) return '';
  const minutes = Math.round((Date.now() - ts) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

export function AccountsPage() {
  const accounts = useApp((s) => s.accounts);
  const profiles = useApp((s) => s.profiles);
  const tasks = useApp((s) => s.tasks);
  const info = useApp((s) => s.info);
  const [filter, setFilter] = useState<RetailerId | 'all'>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<{ id: string | null } | null>(null);
  const [bulk, setBulk] = useState(false);

  const visible = accounts.filter((a) => filter === 'all' || a.retailer === filter);
  useEffect(() => {
    setSelected((current) => {
      const ids = new Set(visible.map((a) => a.id));
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [filter, accounts]);

  const allSelected = visible.length > 0 && visible.every((a) => selected.has(a.id));
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const remove = async (ids: string[]) => {
    const inUse = tasks.filter((t) => ids.includes(t.accountId)).length;
    const ok = await confirm({
      title: ids.length === 1 ? 'Delete account?' : `Delete ${ids.length} accounts?`,
      message: `The saved login and its signed-in session are erased from this computer.${inUse ? ` ${inUse} task(s) use ${ids.length === 1 ? 'it' : 'them'} and will be stopped.` : ''}`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) await act(call('accounts:remove', ids), (r) => r.message);
  };

  const clearSession = async (account: AccountPublic) => {
    const ok = await confirm({
      title: 'Clear saved session?',
      message: `Signs "${account.label}" out of this app by erasing its cookies. Its tasks are stopped.`,
      confirmLabel: 'Clear session',
    });
    if (ok) await act(call('accounts:clearSession', account.id), (r) => r.message);
  };

  const counts = useMemo(() => {
    const map: Record<string, number> = { all: accounts.length };
    for (const a of accounts) map[a.retailer] = (map[a.retailer] ?? 0) + 1;
    return map;
  }, [accounts]);

  return (
    <>
      <PageHeader
        title="Accounts"
        subtitle="Retailer logins. Each one runs in its own isolated browser profile, separate from your own browsers."
        actions={
          <>
            <Button variant="primary" onClick={() => setForm({ id: null })}>
              <Plus size={16} /> Add account
            </Button>
            <Button variant="pink" onClick={() => setBulk(true)}>
              <Users size={15} /> Bulk add
            </Button>
            <Button onClick={() => void act(call('accounts:checkAll', filter === 'all' ? null : filter), (r) => r.message)}>
              <RefreshCw size={14} /> Check sessions
            </Button>
          </>
        }
      />
      <div className="page-body">
        <div className="banner">
          <ShieldCheck size={18} color="var(--accent)" />
          <div className="grow">
            Logins are encrypted with {info?.encryption.backend ?? 'the OS key store'} and never leave this computer. Passwords are not shown again or logged.
            Use <b>Sign in</b> to log in by hand (for 2FA); the session is kept for checkout.
          </div>
        </div>
        <div className="toolbar">
          <div className="segmented">
            <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
              All ({counts.all ?? 0})
            </button>
            {RETAILER_LIST.map((r) => (
              <button key={r.id} className={filter === r.id ? 'active' : ''} onClick={() => setFilter(r.id)}>
                {r.name} ({counts[r.id] ?? 0})
              </button>
            ))}
          </div>
          <div className="spacer" />
          {selected.size > 0 ? (
            <Button small variant="danger" onClick={() => void remove([...selected])}>
              <Trash2 size={14} /> Delete {selected.size}
            </Button>
          ) : null}
        </div>
        {accounts.length === 0 ? (
          <div className="card">
            <EmptyState icon={<KeyRound size={22} />} title="No accounts yet">
              <div>Add the retailer accounts you already have. Use Bulk add to paste many at once.</div>
              <div className="toolbar">
                <Button variant="primary" onClick={() => setForm({ id: null })}>
                  <Plus size={16} /> Add account
                </Button>
                <Button variant="pink" onClick={() => setBulk(true)}>
                  <Users size={15} /> Bulk add
                </Button>
              </div>
            </EmptyState>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th style={{ width: 34 }}>
                    <input
                      type="checkbox"
                      className="check"
                      checked={allSelected}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(visible.map((a) => a.id)))}
                      aria-label="Select all"
                    />
                  </th>
                  <th>Account</th>
                  <th>Store</th>
                  <th>Default profile</th>
                  <th>Session</th>
                  <th className="num">Tasks</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((a) => {
                  const session = SESSION[a.session];
                  const profile = profiles.find((p) => p.id === a.profileId);
                  const taskCount = tasks.filter((t) => t.accountId === a.id).length;
                  return (
                    <tr key={a.id} className={selected.has(a.id) ? 'selected' : ''}>
                      <td>
                        <input type="checkbox" className="check" checked={selected.has(a.id)} onChange={() => toggle(a.id)} aria-label="Select account" />
                      </td>
                      <td>
                        <div>{a.label}</div>
                        <div className="faint" style={{ fontSize: 12 }}>
                          {a.emailMasked}
                          {a.hasPassword ? '' : ' · no password saved'}
                          {a.hasTwoFactorNote ? ' · 2FA note' : ''}
                        </div>
                      </td>
                      <td>
                        <RetailerBadge id={a.retailer} />
                      </td>
                      <td>{profile ? profile.name : <span className="faint">None</span>}</td>
                      <td style={{ maxWidth: 320 }}>
                        <span className={`badge ${session.cls}`}>{session.label}</span>
                        <div className="status-msg" title={a.sessionMessage}>
                          {a.sessionMessage}
                          {a.sessionCheckedAt ? ` · ${timeAgo(a.sessionCheckedAt)}` : ''}
                        </div>
                      </td>
                      <td className="num">{taskCount}</td>
                      <td className="actions">
                        <IconButton label="Sign in (opens a window)" onClick={() => void act(call('accounts:openSignIn', a.id), (r) => r.message)}>
                          <LogIn size={15} />
                        </IconButton>
                        <IconButton label="Check session" onClick={() => void act(call('accounts:checkSession', a.id))}>
                          <RefreshCw size={14} />
                        </IconButton>
                        <IconButton label="Edit" onClick={() => setForm({ id: a.id })}>
                          <Pencil size={14} />
                        </IconButton>
                        <IconButton label="Clear saved session" onClick={() => void clearSession(a)}>
                          <Cookie size={14} />
                        </IconButton>
                        <IconButton label="Delete" onClick={() => void remove([a.id])}>
                          <Trash2 size={14} />
                        </IconButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {form ? <AccountForm id={form.id} defaultRetailer={filter === 'all' ? 'target' : filter} onClose={() => setForm(null)} /> : null}
      {bulk ? <BulkAccountsForm defaultRetailer={filter === 'all' ? 'target' : filter} onClose={() => setBulk(false)} /> : null}
    </>
  );
}

function ProfileSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const profiles = useApp((s) => s.profiles);
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">No default (pick per task)</option>
      {profiles.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} · card {p.cardLast4}
        </option>
      ))}
    </select>
  );
}

function AccountForm({ id, defaultRetailer, onClose }: { id: string | null; defaultRetailer: RetailerId; onClose: () => void }) {
  const [draft, setDraft] = useState<AccountInput & { password: string; twoFactorNote: string; profileId: string }>({
    retailer: defaultRetailer,
    label: '',
    email: '',
    password: '',
    twoFactorNote: '',
    profileId: '',
  });
  const [hasPassword, setHasPassword] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(Boolean(id));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    void act(call('accounts:getEditable', id)).then((acc) => {
      if (acc) {
        setDraft({ retailer: acc.retailer, label: acc.label, email: acc.email, password: '', twoFactorNote: acc.twoFactorNote, profileId: acc.profileId });
        setHasPassword(acc.hasPassword);
      }
      setLoading(false);
    });
  }, [id]);

  const save = async () => {
    const payload: AccountInput = {
      retailer: draft.retailer,
      label: draft.label,
      email: draft.email,
      ...(draft.password ? { password: draft.password } : {}),
      twoFactorNote: draft.twoFactorNote,
      ...(draft.profileId ? { profileId: draft.profileId } : {}),
    };
    const check = accountInputSchema.safeParse(payload);
    if (!check.success) return setError(firstIssue(check.error));
    setError(null);
    const result = id ? await act(call('accounts:update', id, payload), 'Account saved') : await act(call('accounts:create', payload), 'Account added');
    if (result) onClose();
  };

  return (
    <Modal
      title={id ? 'Edit account' : 'Add account'}
      icon={<KeyRound size={18} color="var(--accent)" />}
      onClose={onClose}
      small
      footer={
        <>
          <div className="grow">{error ? <span className="danger-text">{error}</span> : null}</div>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={loading} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Store">
        <select className="select" value={draft.retailer} onChange={(e) => setDraft({ ...draft, retailer: e.target.value as RetailerId })}>
          {RETAILER_LIST.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Label" help="A name for this account, e.g. “Main” or “Mom’s”">
        <input className="input" value={draft.label} maxLength={60} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
      </Field>
      <Field label="Email (or phone for Amazon)">
        <input className="input" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} autoComplete="off" spellCheck={false} />
      </Field>
      <Field label="Password" help={id && hasPassword ? 'Leave empty to keep the saved password.' : 'Optional: without it, sign in by hand with the Sign in button.'}>
        <div className="input-with-addon">
          <input
            className="input"
            type={showPassword ? 'text' : 'password'}
            value={draft.password}
            onChange={(e) => setDraft({ ...draft, password: e.target.value })}
            autoComplete="new-password"
            placeholder={id && hasPassword ? '•••••••• (saved)' : ''}
          />
          <span className="addon">
            <IconButton label={showPassword ? 'Hide' : 'Show'} onClick={() => setShowPassword(!showPassword)}>
              {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
            </IconButton>
          </span>
        </div>
      </Field>
      <Field label="2FA note (optional)" help="A reminder for you, e.g. “codes go to my phone ending 42”. Stored encrypted.">
        <input className="input" value={draft.twoFactorNote} maxLength={200} onChange={(e) => setDraft({ ...draft, twoFactorNote: e.target.value })} />
      </Field>
      <Field label="Default profile" help="The card and address this account checks out with in multi-account tasks.">
        <ProfileSelect value={draft.profileId} onChange={(profileId) => setDraft({ ...draft, profileId })} />
      </Field>
    </Modal>
  );
}

function BulkAccountsForm({ defaultRetailer, onClose }: { defaultRetailer: RetailerId; onClose: () => void }) {
  const accounts = useApp((s) => s.accounts);
  const [retailer, setRetailer] = useState<RetailerId>(defaultRetailer);
  const [text, setText] = useState('');
  const [profileId, setProfileId] = useState('');
  const [labelPrefix, setLabelPrefix] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const preview = useMemo(() => parseAccountLines(text), [text]);
  const savedCount = accounts.filter((a) => a.retailer === retailer).length;

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 500_000) {
      useApp.getState().toast('error', 'That file is larger than 500 KB.');
      return;
    }
    setText(await file.text());
  };

  const submit = async () => {
    setBusy(true);
    const result = await act(
      call('accounts:bulkCreate', {
        retailer,
        text,
        ...(profileId ? { profileId } : {}),
        ...(labelPrefix.trim() ? { labelPrefix: labelPrefix.trim() } : {}),
      }),
    );
    setBusy(false);
    if (!result) return;
    const level = result.created > 0 ? 'success' : 'warn';
    useApp
      .getState()
      .toast(level, `Added ${result.created} ${RETAILERS[retailer].name} account(s)${result.skipped ? `, skipped ${result.skipped} already saved or repeated` : ''}${result.errors.length ? `, ${result.errors.length} line(s) had problems` : ''}.`);
    if (result.created > 0) onClose();
  };

  return (
    <Modal
      title="Bulk add accounts"
      icon={<Users size={18} color="var(--pink)" />}
      onClose={onClose}
      footer={
        <>
          <div className="grow">
            {preview.entries.length} ready
            {preview.duplicates ? ` · ${preview.duplicates} repeated` : ''}
            {preview.errors.length ? ` · ${preview.errors.length} problem(s)` : ''}
            {` · ${savedCount} ${RETAILERS[retailer].name} account(s) already saved`}
          </div>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || preview.entries.length === 0} onClick={() => void submit()}>
            Add {preview.entries.length || ''} account{preview.entries.length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <div className="muted">
        Add accounts you already own, one per line. Each account becomes its own isolated session, and new tasks can run on all of them
        at once. The app does not create retailer accounts.
      </div>
      <div className="form-grid three">
        <Field label="Store">
          <select className="select" value={retailer} onChange={(e) => setRetailer(e.target.value as RetailerId)}>
            {RETAILER_LIST.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Default profile for all">
          <ProfileSelect value={profileId} onChange={setProfileId} />
        </Field>
        <Field label="Label prefix" help={`Labels become "${labelPrefix.trim() || RETAILERS[retailer].name} #1", "#2"…`}>
          <input className="input" value={labelPrefix} maxLength={40} onChange={(e) => setLabelPrefix(e.target.value)} placeholder={RETAILERS[retailer].name} />
        </Field>
      </div>
      <Field label="Accounts" help={`email:password per line (a comma or tab also works). Lines starting with # are ignored. Up to ${MAX_BULK_ACCOUNTS} at once.`}>
        <textarea
          className="textarea"
          rows={10}
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          placeholder={'name1@example.com:password1\nname2@example.com:password2'}
        />
      </Field>
      <div className="toolbar">
        <Button small onClick={() => fileRef.current?.click()}>
          <FileUp size={14} /> Load from .txt / .csv
        </Button>
        <input ref={fileRef} type="file" accept=".txt,.csv,text/plain,text/csv" hidden onChange={(e) => void loadFile(e.target.files?.[0])} />
        {text ? (
          <Button small variant="ghost" onClick={() => setText('')}>
            Clear
          </Button>
        ) : null}
      </div>
      {preview.errors.length ? (
        <div className="banner danger">
          <div className="grow">
            {preview.errors.slice(0, 6).map((e) => (
              <div key={e}>{e}</div>
            ))}
            {preview.errors.length > 6 ? <div>…and {preview.errors.length - 6} more</div> : null}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
