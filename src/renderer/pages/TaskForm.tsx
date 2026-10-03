import { BookOpen, Link2, ListChecks, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { describeKeywords, parseKeywords } from '../../shared/keywords';
import { formatUsd } from '../../shared/money';
import { detectRetailer, parseProductInput, RETAILER_LIST, RETAILERS } from '../../shared/retailers';
import { firstIssue, taskInputSchema } from '../../shared/schemas';
import { RETAILER_IDS, type AccountPublic, type RetailerId, type TaskInput, type TaskView } from '../../shared/types';
import { call } from '../api';
import { Button, Field, Modal, Toggle } from '../components/ui';
import { act, useApp } from '../store';

type Source = 'url' | 'keyword' | 'catalog';

const SESSION_LABELS: Record<AccountPublic['session'], { text: string; cls: string }> = {
  unknown: { text: 'Not checked', cls: '' },
  checking: { text: 'Checking', cls: 'accent' },
  signed_in: { text: 'Signed in', cls: 'ok' },
  signed_out: { text: 'Signed out', cls: 'warn' },
  needs_attention: { text: 'Needs you', cls: 'danger' },
};

export function TaskForm({ task, catalogEntryId, onClose }: { task?: TaskView; catalogEntryId?: string; onClose: () => void }) {
  const profiles = useApp((s) => s.profiles);
  const accounts = useApp((s) => s.accounts);
  const catalog = useApp((s) => s.catalog);
  const settings = useApp((s) => s.settings);
  const setTab = useApp((s) => s.setTab);
  const editing = Boolean(task);
  const maxQuantity = settings?.maxQuantityPerTask ?? 2;

  const [source, setSource] = useState<Source>(task ? (task.mode === 'keyword' ? 'keyword' : task.catalogEntryId ? 'catalog' : 'url') : catalogEntryId ? 'catalog' : 'url');
  const [retailer, setRetailer] = useState<RetailerId>(task?.retailer ?? 'target');
  const [input, setInput] = useState(task?.input ?? '');
  const [entryId, setEntryId] = useState(task?.catalogEntryId ?? catalogEntryId ?? '');
  const [entrySearch, setEntrySearch] = useState('');
  const [label, setLabel] = useState(task?.label ?? '');
  const [accountIds, setAccountIds] = useState<string[]>(task ? [task.accountId] : []);
  const [profileId, setProfileId] = useState(task?.profileId ?? profiles[0]?.id ?? '');
  const [useAccountProfiles, setUseAccountProfiles] = useState(true);
  const [quantity, setQuantity] = useState(String(task?.quantity ?? 1));
  const [maxPrice, setMaxPrice] = useState(task ? String(task.maxPrice) : '');
  const [copies, setCopies] = useState('1');
  const [firstN, setFirstN] = useState('5');
  const [groupName, setGroupName] = useState('');
  const [groupGoal, setGroupGoal] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const entries = catalog?.entries ?? [];
  const entry = entries.find((e) => e.id === entryId);
  const entryRetailers = entry ? RETAILER_IDS.filter((id) => entry.retailers[id].url || entry.retailers[id].sku) : [];

  // Picking a catalog entry fills in the product and a sensible default price.
  useEffect(() => {
    if (source !== 'catalog' || !entry) return;
    const target = entryRetailers.includes(retailer) ? retailer : entryRetailers[0];
    if (!target) return;
    if (target !== retailer) setRetailer(target);
    const ref = entry.retailers[target];
    setInput(ref.url || ref.sku);
    if (!label || entries.some((e) => e.name === label)) setLabel(entry.name);
    if (!maxPrice && entry.msrp) setMaxPrice(String(entry.msrp));
    // Only re-run when the chosen entry or store changes; label/price edits must stick.
  }, [source, entryId, retailer]);

  const retailerAccounts = accounts.filter((a) => a.retailer === retailer);
  // Switching store drops accounts from the old store and starts with that store's first account.
  useEffect(() => {
    setAccountIds((ids) => {
      const kept = ids.filter((id) => accounts.find((a) => a.id === id)?.retailer === retailer);
      if (kept.length > 0 || editing) return kept;
      const first = accounts.find((a) => a.retailer === retailer);
      return first ? [first.id] : [];
    });
  }, [retailer, accounts, editing]);

  const parsed = useMemo(() => (source === 'keyword' || !input.trim() ? null : parseProductInput(retailer, input)), [source, retailer, input]);
  const keywords = useMemo(() => (source === 'keyword' ? parseKeywords(input) : null), [source, input]);

  const onUrlChange = (value: string) => {
    setInput(value);
    const detected = detectRetailer(value);
    if (detected) setRetailer(detected);
  };

  const toggleAccount = (id: string) => {
    if (editing) {
      setAccountIds([id]);
      return;
    }
    setAccountIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  };
  const selectFirst = () => {
    const n = Math.max(1, Math.min(retailerAccounts.length, Number.parseInt(firstN, 10) || 1));
    setAccountIds(retailerAccounts.slice(0, n).map((a) => a.id));
  };

  const copiesNum = Math.max(1, Math.min(20, Number.parseInt(copies, 10) || 1));
  const totalTasks = editing ? 1 : accountIds.length * copiesNum;
  const usesDefaults = accountIds.some((id) => accounts.find((a) => a.id === id)?.profileId);

  const submit = async () => {
    setError(null);
    const draft: TaskInput = {
      retailer,
      mode: source === 'keyword' ? 'keyword' : 'url',
      input: input.trim(),
      ...(source === 'catalog' && entryId ? { catalogEntryId: entryId } : {}),
      ...(label.trim() ? { label: label.trim() } : {}),
      profileId,
      accountId: accountIds[0] ?? '',
      quantity: Number.parseInt(quantity, 10),
      maxPrice: Number.parseFloat(maxPrice),
    };
    const check = taskInputSchema.safeParse(draft);
    if (!check.success) return setError(firstIssue(check.error));
    if (draft.quantity > maxQuantity) return setError(`Quantity is above the global max of ${maxQuantity} (Settings → Safety).`);
    if (accountIds.length === 0) return setError('Pick at least one account.');
    const goal = groupGoal.trim() ? Number.parseInt(groupGoal, 10) : null;
    if (goal !== null && (!Number.isInteger(goal) || goal < 1)) return setError('“Stop after” must be a whole number of orders, or empty.');
    setSaving(true);
    const result = task
      ? await act(call('tasks:update', task.id, draft), 'Task saved')
      : await act(
          call('tasks:create', {
            input: draft,
            accountIds,
            useAccountProfiles,
            copies: copiesNum,
            groupName: groupName.trim(),
            groupGoal: goal,
          }),
          (created) => (created.length === 1 ? 'Task created' : `Created ${created.length} tasks`),
        );
    setSaving(false);
    if (result) onClose();
  };

  const filteredEntries = entries.filter((e) => `${e.name} ${e.set} ${e.category} ${e.tags.join(' ')}`.toLowerCase().includes(entrySearch.trim().toLowerCase()));

  return (
    <Modal
      title={editing ? 'Edit task' : 'New task'}
      icon={<ListChecks size={18} color="var(--accent)" />}
      onClose={onClose}
      footer={
        <>
          <div className="grow">
            {error ? (
              <span className="danger-text">{error}</span>
            ) : editing ? (
              'Changes apply the next time the task starts.'
            ) : (
              `Creates ${totalTasks} task${totalTasks === 1 ? '' : 's'}${totalTasks > 1 ? ` in one group (${accountIds.length} account${accountIds.length === 1 ? '' : 's'} × ${copiesNum})` : ''}`
            )}
          </div>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={saving} onClick={() => void submit()}>
            {editing ? 'Save task' : totalTasks > 1 ? `Create ${totalTasks} tasks` : 'Create task'}
          </Button>
        </>
      }
    >
      <div className="segmented" role="tablist">
        <button className={source === 'url' ? 'active' : ''} onClick={() => setSource('url')}>
          <Link2 size={14} /> Product URL / SKU
        </button>
        <button className={source === 'keyword' ? 'active' : ''} onClick={() => setSource('keyword')}>
          <Search size={14} /> Keywords
        </button>
        <button className={source === 'catalog' ? 'active' : ''} onClick={() => setSource('catalog')}>
          <BookOpen size={14} /> Catalog
        </button>
      </div>

      {source === 'catalog' ? (
        <div className="form-grid">
          <Field label="Catalog entry" className="span-all" help={entries.length === 0 ? 'The catalog is empty. Add entries in the Catalog tab.' : undefined}>
            <input className="input" placeholder="Filter entries" value={entrySearch} onChange={(e) => setEntrySearch(e.target.value)} />
            <select className="select" value={entryId} onChange={(e) => setEntryId(e.target.value)} size={Math.min(6, Math.max(3, filteredEntries.length))} style={{ height: 'auto', padding: 4 }}>
              {filteredEntries.map((e) => {
                const filled = RETAILER_IDS.filter((id) => e.retailers[id].url || e.retailers[id].sku).length;
                return (
                  <option key={e.id} value={e.id}>
                    {e.name} {filled === 0 ? '(no links yet)' : `(${filled} store${filled === 1 ? '' : 's'})`}
                  </option>
                );
              })}
            </select>
          </Field>
          {entry && entryRetailers.length === 0 ? (
            <div className="banner pink span-all">This entry has no retailer URL or SKU yet. Edit it in the Catalog tab first.</div>
          ) : null}
        </div>
      ) : null}

      <div className="form-grid">
        <Field label="Store">
          <select
            className="select"
            value={retailer}
            onChange={(e) => setRetailer(e.target.value as RetailerId)}
            disabled={source === 'catalog' && entryRetailers.length <= 1}
          >
            {(source === 'catalog' && entryRetailers.length ? RETAILER_LIST.filter((r) => entryRetailers.includes(r.id)) : RETAILER_LIST).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Label (optional)" help="Shown in the table and notifications">
          <input className="input" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. 30th Celebration ETB" />
        </Field>

        {source === 'keyword' ? (
          <Field
            label="Keywords"
            className="span-all"
            error={keywords && input.trim() && keywords.positive.length === 0 ? 'Add at least one keyword that must match' : null}
            ok={keywords && keywords.positive.length ? `Matches titles with ${describeKeywords(keywords)}` : null}
            help='Comma or space separated. Prefix with "-" to exclude, e.g. pokemon, elite trainer box, -sleeves'
          >
            <input className="input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="pokemon, elite trainer box, -sleeves" />
          </Field>
        ) : (
          <Field
            label={source === 'catalog' ? 'Product (from catalog)' : 'Product URL or ID'}
            className="span-all"
            error={parsed && !parsed.ok ? parsed.error : null}
            ok={parsed && parsed.ok ? `${RETAILERS[retailer].name} ${RETAILERS[retailer].productIdLabel} ${parsed.product.productId}` : null}
            help={RETAILERS[retailer].inputHint}
          >
            <input className="input" value={input} onChange={(e) => onUrlChange(e.target.value)} placeholder="Paste a product link" readOnly={source === 'catalog'} />
          </Field>
        )}
      </div>

      <div className="section-title">{editing ? 'Account' : 'Accounts'}</div>
      {retailerAccounts.length === 0 ? (
        <div className="banner pink">
          <div className="grow">No {RETAILERS[retailer].name} accounts yet.</div>
          <Button small onClick={() => setTab('accounts')}>
            Add accounts
          </Button>
        </div>
      ) : (
        <>
          {!editing ? (
            <div className="choice-head">
              <span className="muted" title="Each selected account gets its own task, session and checkout.">
                {accountIds.length} of {retailerAccounts.length} selected · one task per account
              </span>
              <div className="spacer" style={{ flex: 1 }} />
              <Button small onClick={() => setAccountIds(retailerAccounts.map((a) => a.id))}>
                All
              </Button>
              <Button small onClick={() => setAccountIds([])}>
                None
              </Button>
              <span className="faint">First</span>
              <input className="input" style={{ width: 60, height: 28 }} value={firstN} onChange={(e) => setFirstN(e.target.value.replace(/\D/g, ''))} />
              <Button small onClick={selectFirst}>
                Select
              </Button>
            </div>
          ) : null}
          <div className="choice-list">
            {retailerAccounts.map((account) => {
              const session = SESSION_LABELS[account.session];
              const defaultProfile = profiles.find((p) => p.id === account.profileId);
              return (
                <label key={account.id} className="choice">
                  <input
                    type={editing ? 'radio' : 'checkbox'}
                    className="check"
                    name="task-account"
                    checked={accountIds.includes(account.id)}
                    onChange={() => toggleAccount(account.id)}
                  />
                  <div className="grow">
                    <div>{account.label}</div>
                    <div className="faint" style={{ fontSize: 12 }}>
                      {account.emailMasked}
                      {defaultProfile ? ` · profile: ${defaultProfile.name}` : ''}
                    </div>
                  </div>
                  <span className={`badge ${session.cls}`}>{session.text}</span>
                </label>
              );
            })}
          </div>
        </>
      )}

      <div className="section-title">Checkout</div>
      <div className="form-grid three">
        <Field
          label="Profile"
          help={profiles.length === 0 ? 'Create a profile first (Profiles tab).' : !editing && useAccountProfiles && usesDefaults ? 'Used for accounts without a default profile' : 'Ship-to address and saved card (last 4)'}
        >
          <select className="select" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            <option value="">Pick a profile</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · card {p.cardLast4}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Quantity" help={`Global max is ${maxQuantity}`}>
          <input className="input" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/\D/g, ''))} />
        </Field>
        <Field label="Max price per item" help="Before tax and shipping. Above this, nothing is bought.">
          <div className="prefix-input">
            <span>$</span>
            <input className="input" inputMode="decimal" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value.replace(/[^\d.]/g, ''))} placeholder="59.99" />
          </div>
        </Field>
      </div>
      {!editing && usesDefaults ? (
        <div className="toggle-row">
          <div className="text">
            <div className="title">Use each account’s default profile</div>
            <div className="desc">Accounts with a default profile check out with their own card and address.</div>
          </div>
          <Toggle on={useAccountProfiles} onChange={setUseAccountProfiles} label="Use each account's default profile" />
        </div>
      ) : null}

      {!editing ? (
        <>
          <div className="section-title">Group</div>
          <div className="form-grid three">
            <Field label="Copies per account" help="Usually 1. More copies on one account buy more on that account.">
              <input className="input" inputMode="numeric" value={copies} onChange={(e) => setCopies(e.target.value.replace(/\D/g, ''))} />
            </Field>
            <Field label="Group name" help="Used when more than one task is created">
              <input className="input" value={groupName} maxLength={60} onChange={(e) => setGroupName(e.target.value)} placeholder={label || 'e.g. ETB drop'} />
            </Field>
            <Field label="Stop group after N orders" help="Empty = every task may check out once">
              <input className="input" inputMode="numeric" value={groupGoal} onChange={(e) => setGroupGoal(e.target.value.replace(/\D/g, ''))} placeholder="no limit" />
            </Field>
          </div>
          {totalTasks > 1 ? (
            <div className="muted" style={{ fontSize: 12.5 }}>
              Worst case this group can buy {groupGoal ? Math.min(Number(groupGoal), totalTasks) : totalTasks} order(s) × {quantity || 1} item(s)
              {maxPrice ? ` at up to ${formatUsd(Number(maxPrice))} each` : ''}. The global concurrency limit ({settings?.maxConcurrency ?? 4}) caps how many check out at once.
            </div>
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}
