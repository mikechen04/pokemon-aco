import { CreditCard, MapPin, Pencil, Plus, ShieldCheck, Trash2, UserRound } from 'lucide-react';
import { useState } from 'react';
import { US_STATES } from '../../shared/constants';
import { firstIssue, profileInputSchema } from '../../shared/schemas';
import type { Address, Profile, ProfileInput } from '../../shared/types';
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
        subtitle="Where orders ship, and which card already saved on the retailer account to use."
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
            The app never asks for, stores or sends card numbers or security codes. Checkout selects the card already saved on your
            retailer account by its last 4 digits, and pauses if the retailer asks for card details.
          </div>
        </div>
        {profiles.length === 0 ? (
          <div className="card">
            <EmptyState icon={<UserRound size={22} />} title="No profiles yet">
              <div>A profile is a ship-to address plus the last 4 digits of a card saved on your retailer accounts.</div>
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
                      <CreditCard size={14} /> •••• {p.cardLast4}
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

function ProfileForm({ profile, onClose }: { profile: Profile | null; onClose: () => void }) {
  const [draft, setDraft] = useState<ProfileInput>(
    profile
      ? { name: profile.name, shipping: profile.shipping, billingSameAsShipping: profile.billingSameAsShipping, billing: profile.billing, cardLast4: profile.cardLast4, cardLabel: profile.cardLabel }
      : { name: '', shipping: EMPTY_ADDRESS, billingSameAsShipping: true, billing: EMPTY_ADDRESS, cardLast4: '', cardLabel: '' },
  );
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const candidate = { ...draft, billing: draft.billingSameAsShipping ? draft.shipping : draft.billing };
    const check = profileInputSchema.safeParse(candidate);
    if (!check.success) return setError(firstIssue(check.error));
    setError(null);
    const result = profile
      ? await act(call('profiles:update', profile.id, candidate), 'Profile saved')
      : await act(call('profiles:create', candidate), 'Profile created');
    if (result) onClose();
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
          <div className="desc">Turn off if the saved card bills to a different address.</div>
        </div>
        <Toggle on={draft.billingSameAsShipping} onChange={(on) => setDraft({ ...draft, billingSameAsShipping: on })} label="Billing same as shipping" />
      </div>
      {!draft.billingSameAsShipping ? (
        <>
          <div className="section-title">Billing address</div>
          <AddressFields value={draft.billing} onChange={(billing) => setDraft({ ...draft, billing })} />
        </>
      ) : null}
      <div className="section-title">Saved card</div>
      <div className="form-grid">
        <Field label="Last 4 digits of the card saved on the retailer account" help="Only these 4 digits are stored. Never enter a full card number.">
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
    </Modal>
  );
}
