import { CreditCard, KeyRound, Lock, MapPin, Pencil, Plus, ShieldCheck, Store, Trash2, UserRound } from 'lucide-react';
import { useState } from 'react';
import { CARD_BRAND_LABELS, cardBrand, cardExpired, cvvLength, digitsOnly, formatCardNumber, formatExpiry } from '../../shared/cards';
import { US_STATES } from '../../shared/constants';
import { cardInputSchema, firstIssue, profileInputSchema } from '../../shared/schemas';
import type { Address, CardInput, CardSummary, Profile, ProfileInput } from '../../shared/types';
import { call } from '../api';
import { PageHeader } from '../App';
import { Button, confirm, EmptyState, Field, IconButton, Modal, Toggle } from '../components/ui';
import { act, useApp } from '../store';

const EMPTY_ADDRESS: Address = { firstName: '', lastName: '', address1: '', address2: '', city: '', state: '', zip: '', phone: '' };

export function ProfilesPage() {
  const profiles = useApp((s) => s.profiles);
  const tasks = useApp((s) => s.tasks);
  const accounts = useApp((s) => s.accounts);
  const [editing, setEditing] = useState<Profile | 'new' | null>(null);

  const remove = async (profile: Profile) => {
    const ok = await confirm({ title: `Delete profile "${profile.name}"?`, message: 'Accounts that use it as their default will have no default profile.', confirmLabel: 'Delete', danger: true });
    if (ok) await act(call('profiles:remove', profile.id), 'Profile deleted');
  };

  return (
    <>
      <PageHeader
        title="Profiles"
        subtitle="Where orders ship, and which card pays: one saved on the store account, or a card stored here."
        actions={
          <Button variant="primary" onClick={() => setEditing('new')}>
            <Plus size={16} /> New profile
          </Button>
        }
      />
      <div className="page-body">
        <div className="banner">
          <ShieldCheck size={18} color="var(--accent)" />
          <div className="grow">
            Checkout first picks the card already saved on the store account by its last 4 digits. You can also store a full card on a
            profile (for example a virtual card): it is encrypted with Windows DPAPI, never shown again or logged, and only typed into the
            store’s own checkout page when the account has no saved card or the store asks for the security code.
          </div>
        </div>
        {profiles.length === 0 ? (
          <div className="card">
            <EmptyState icon={<UserRound size={22} />} title="No profiles yet">
              <div>A profile is a ship-to address plus the card to pay with: one saved on your store accounts (by its last 4), or a stored card.</div>
              <Button variant="primary" onClick={() => setEditing('new')}>
                <Plus size={16} /> New profile
              </Button>
            </EmptyState>
          </div>
        ) : (
          <div className="card-grid">
            {profiles.map((p) => {
              const used = tasks.filter((t) => t.profileId === p.id).length;
              const defaults = accounts.filter((a) => a.profileId === p.id).length;
              return (
                <div key={p.id} className="item-card">
                  <div className="top">
                    <div style={{ flex: 1 }}>
                      <div className="title">{p.name}</div>
                      <div className="meta">
                        {p.shipping.firstName} {p.shipping.lastName}
                      </div>
                    </div>
                    <span className="card-chip">
                      <CreditCard size={14} /> {p.card ? `${CARD_BRAND_LABELS[p.card.brand]} ` : ''}•••• {p.cardLast4}
                    </span>
                  </div>
                  <div className="meta" style={{ display: 'flex', gap: 6 }}>
                    <MapPin size={14} style={{ flex: 'none', marginTop: 2 }} />
                    <span>
                      {p.shipping.address1}
                      {p.shipping.address2 ? `, ${p.shipping.address2}` : ''}, {p.shipping.city}, {p.shipping.state} {p.shipping.zip}
                    </span>
                  </div>
                  <div className="row">
                    {p.card ? (
                      cardExpired(p.card.expMonth, p.card.expYear) ? (
                        <span className="badge danger">Stored card expired {formatExpiry(p.card.expMonth, p.card.expYear)}</span>
                      ) : (
                        <span className="badge pink">
                          <Lock size={11} /> Stored card · exp {formatExpiry(p.card.expMonth, p.card.expYear)}
                        </span>
                      )
                    ) : (
                      <span className="badge">Saved on store account</span>
                    )}
                    {p.cardLabel ? <span className="badge">{p.cardLabel}</span> : null}
                    <span className="badge">{p.billingSameAsShipping ? 'Billing = shipping' : 'Separate billing'}</span>
                    <span className="badge accent">{used} task{used === 1 ? '' : 's'}</span>
                    {defaults ? <span className="badge pink">default for {defaults} account{defaults === 1 ? '' : 's'}</span> : null}
                  </div>
                  <div className="foot">
                    <Button small onClick={() => setEditing(p)}>
                      <Pencil size={13} /> Edit
                    </Button>
                    <div style={{ flex: 1 }} />
                    <IconButton label="Delete" onClick={() => void remove(p)}>
                      <Trash2 size={14} />
                    </IconButton>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {editing ? <ProfileForm profile={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function AddressFields({ value, onChange }: { value: Address; onChange: (next: Address) => void }) {
  const set = (key: keyof Address) => (e: { target: { value: string } }) => onChange({ ...value, [key]: e.target.value });
  return (
    <div className="form-grid four">
      <Field label="First name" className="span-2">
        <input className="input" value={value.firstName} onChange={set('firstName')} autoComplete="off" />
      </Field>
      <Field label="Last name" className="span-2">
        <input className="input" value={value.lastName} onChange={set('lastName')} autoComplete="off" />
      </Field>
      <Field label="Address" className="span-2">
        <input className="input" value={value.address1} onChange={set('address1')} autoComplete="off" />
      </Field>
      <Field label="Apt / suite (optional)" className="span-2">
        <input className="input" value={value.address2} onChange={set('address2')} autoComplete="off" />
      </Field>
      <Field label="City">
        <input className="input" value={value.city} onChange={set('city')} autoComplete="off" />
      </Field>
      <Field label="State">
        <select className="select" value={value.state} onChange={set('state')}>
          <option value="">—</option>
          {US_STATES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </Field>
      <Field label="ZIP">
        <input className="input" value={value.zip} onChange={set('zip')} inputMode="numeric" autoComplete="off" />
      </Field>
      <Field label="Phone">
        <input className="input" value={value.phone} onChange={set('phone')} inputMode="tel" autoComplete="off" />
      </Field>
    </div>
  );
}

const EMPTY_CARD: CardInput = { holder: '', number: '', expMonth: 0, expYear: 0, cvv: '' };

function StoredCardSummary({ card }: { card: CardSummary }) {
  const expired = cardExpired(card.expMonth, card.expYear);
  return (
    <div className="stored-card">
      <CreditCard size={18} color="var(--pink)" />
      <div className="grow">
        <div className="title">
          {CARD_BRAND_LABELS[card.brand]} •••• {card.last4}
        </div>
        <div className="meta">
          {card.holder} · expires {formatExpiry(card.expMonth, card.expYear)}
          {expired ? <span className="danger-text"> · expired</span> : null}
        </div>
      </div>
    </div>
  );
}

function CardFields({ value, onChange }: { value: CardInput; onChange: (next: CardInput) => void }) {
  const brand = cardBrand(value.number);
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 16 }, (_, i) => thisYear + i);
  return (
    <div className="form-grid four">
      <Field label="Name on card" className="span-2">
        <input className="input" value={value.holder} maxLength={80} autoComplete="off" onChange={(e) => onChange({ ...value, holder: e.target.value })} />
      </Field>
      <Field label="Card number" className="span-2" help={digitsOnly(value.number).length >= 4 ? CARD_BRAND_LABELS[brand] : undefined}>
        <input
          className="input mono"
          value={value.number}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          maxLength={23}
          placeholder="1234 5678 9012 3456"
          onChange={(e) => onChange({ ...value, number: formatCardNumber(e.target.value) })}
        />
      </Field>
      <Field label="Expiry month">
        <select className="select" value={value.expMonth || ''} onChange={(e) => onChange({ ...value, expMonth: Number(e.target.value) })}>
          <option value="">MM</option>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <option key={m} value={m}>
              {String(m).padStart(2, '0')}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Expiry year">
        <select className="select" value={value.expYear || ''} onChange={(e) => onChange({ ...value, expYear: Number(e.target.value) })}>
          <option value="">YYYY</option>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Security code">
        <input
          className="input mono"
          type="password"
          value={value.cvv}
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          placeholder={brand === 'amex' ? '4 digits' : '3 digits'}
          onChange={(e) => onChange({ ...value, cvv: digitsOnly(e.target.value).slice(0, cvvLength(brand === 'other' ? 'amex' : brand)) })}
        />
      </Field>
    </div>
  );
}

function ProfileForm({ profile, onClose }: { profile: Profile | null; onClose: () => void }) {
  const [draft, setDraft] = useState<ProfileInput>(
    profile
      ? { name: profile.name, shipping: profile.shipping, billingSameAsShipping: profile.billingSameAsShipping, billing: profile.billing, cardLast4: profile.cardLast4, cardLabel: profile.cardLabel }
      : { name: '', shipping: EMPTY_ADDRESS, billingSameAsShipping: true, billing: EMPTY_ADDRESS, cardLast4: '', cardLabel: '' },
  );
  const storedCard = profile?.card ?? null;
  const [cardMode, setCardMode] = useState<'saved' | 'stored'>(storedCard ? 'stored' : 'saved');
  // The full-card fields show for a new stored card, or when replacing the existing one.
  const [replacing, setReplacing] = useState(false);
  const [card, setCard] = useState<CardInput>(EMPTY_CARD);
  // Set once a new profile is created, so a retry after a card error updates it instead of duplicating it.
  const [savedId, setSavedId] = useState<string | null>(profile?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const enteringCard = cardMode === 'stored' && (!storedCard || replacing);

  const save = async () => {
    let cardInput: CardInput | null = null;
    if (enteringCard) {
      const check = cardInputSchema.safeParse(card);
      if (!check.success) return setError(check.error.issues[0]?.message ?? 'Check the card details');
      cardInput = check.data;
    }
    const cardLast4 = cardInput ? cardInput.number.slice(-4) : cardMode === 'stored' && storedCard ? storedCard.last4 : draft.cardLast4;
    const candidate = { ...draft, cardLast4, billing: draft.billingSameAsShipping ? draft.shipping : draft.billing };
    const check = profileInputSchema.safeParse(candidate);
    if (!check.success) return setError(firstIssue(check.error));
    setError(null);
    // Delete the stored card first: while a profile has one, its last 4 follow that card.
    if (cardMode === 'saved' && storedCard && savedId && !(await act(call('profiles:removeCard', savedId)))) return;
    const saved = savedId ? await act(call('profiles:update', savedId, candidate)) : await act(call('profiles:create', candidate));
    if (!saved) return;
    setSavedId(saved.id);
    if (cardInput) {
      if (!(await act(call('profiles:setCard', saved.id, cardInput)))) return;
      setCard(EMPTY_CARD);
    }
    useApp.getState().toast('success', profile ? 'Profile saved' : 'Profile created');
    onClose();
  };

  return (
    <Modal
      title={profile ? `Edit ${profile.name}` : 'New profile'}
      icon={<UserRound size={18} color="var(--accent)" />}
      onClose={onClose}
      footer={
        <>
          <div className="grow">{error ? <span className="danger-text">{error}</span> : 'US addresses only.'}</div>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}>
            Save profile
          </Button>
        </>
      }
    >
      <Field label="Profile name">
        <input className="input" value={draft.name} maxLength={60} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Home" />
      </Field>
      <div className="section-title">Shipping address</div>
      <AddressFields value={draft.shipping} onChange={(shipping) => setDraft({ ...draft, shipping })} />
      <div className="toggle-row">
        <div className="text">
          <div className="title">Billing address is the same</div>
          <div className="desc">Turn off if the card bills to a different address.</div>
        </div>
        <Toggle on={draft.billingSameAsShipping} onChange={(on) => setDraft({ ...draft, billingSameAsShipping: on })} label="Billing same as shipping" />
      </div>
      {!draft.billingSameAsShipping ? (
        <>
          <div className="section-title">Billing address</div>
          <AddressFields value={draft.billing} onChange={(billing) => setDraft({ ...draft, billing })} />
        </>
      ) : null}
      <div className="section-title">Card</div>
      <div className="segmented" role="tablist">
        <button className={cardMode === 'saved' ? 'active' : ''} onClick={() => setCardMode('saved')}>
          <Store size={14} /> Saved on the store account
        </button>
        <button className={cardMode === 'stored' ? 'active' : ''} onClick={() => setCardMode('stored')}>
          <KeyRound size={14} /> Store the full card here
        </button>
      </div>
      {cardMode === 'saved' ? (
        <>
          <div className="form-grid">
            <Field label="Last 4 digits of the card saved on the store account" help="Checkout selects the saved card ending in these digits.">
              <input
                className="input"
                value={draft.cardLast4}
                maxLength={4}
                inputMode="numeric"
                onChange={(e) => setDraft({ ...draft, cardLast4: e.target.value.replace(/\D/g, '').slice(0, 4) })}
                placeholder="1234"
              />
            </Field>
            <Field label="Card nickname (optional)" help="Just for you, e.g. “Chase Visa”">
              <input className="input" value={draft.cardLabel} maxLength={40} onChange={(e) => setDraft({ ...draft, cardLabel: e.target.value })} />
            </Field>
          </div>
          {storedCard ? (
            <div className="banner pink">
              <Trash2 size={16} color="var(--pink)" />
              <div className="grow">Saving with this option deletes the stored card ending in {storedCard.last4} from this computer.</div>
            </div>
          ) : null}
        </>
      ) : (
        <>
          {storedCard && !replacing ? (
            <div className="form-grid">
              <div className="span-all" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <div style={{ flex: 1 }}>
                  <StoredCardSummary card={storedCard} />
                </div>
                <Button small onClick={() => setReplacing(true)}>
                  <Pencil size={13} /> Replace card
                </Button>
              </div>
            </div>
          ) : (
            <CardFields value={card} onChange={setCard} />
          )}
          <Field label="Card nickname (optional)" help="Just for you, e.g. “Privacy.com card”">
            <input className="input" value={draft.cardLabel} maxLength={40} onChange={(e) => setDraft({ ...draft, cardLabel: e.target.value })} />
          </Field>
          <div className="banner">
            <Lock size={16} color="var(--accent)" />
            <div className="grow">
              Encrypted on this computer with Windows DPAPI and never shown again: after saving you only see the brand, last 4 and expiry.
              It is typed only into the store’s own checkout page (and its card processor’s secure fields), and never logged.
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
