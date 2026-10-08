import { CheckCircle2, CircleDashed, ExternalLink, MinusCircle, UserPlus } from 'lucide-react';
import { useEffect, useState, type ReactElement } from 'react';
import { RETAILER_LIST, RETAILERS } from '../../shared/retailers';
import { firstIssue, signupRequestSchema } from '../../shared/schemas';
import type { RetailerId, SignupItemStatus, SignupJobView, SignupRequest } from '../../shared/types';
import { call, subscribe } from '../api';
import { Button, Field, Modal, Toggle } from '../components/ui';
import { act, useApp } from '../store';

const STATUS_ICON: Record<SignupItemStatus, ReactElement> = {
  waiting: <CircleDashed size={15} color="var(--text-faint)" />,
  open: <ExternalLink size={15} color="var(--accent)" />,
  saved: <CheckCircle2 size={15} color="var(--ok)" />,
  skipped: <MinusCircle size={15} color="var(--text-faint)" />,
};

export function SignupAssistant({ defaultRetailer, onClose }: { defaultRetailer: RetailerId; onClose: () => void }) {
  const profiles = useApp((s) => s.profiles);
  const setTab = useApp((s) => s.setTab);
  const [job, setJob] = useState<SignupJobView | null>(null);
  const [draft, setDraft] = useState<SignupRequest>({
    retailer: defaultRetailer,
    emails: '',
    profileId: profiles[0]?.id ?? '',
    passwordMode: 'generate',
    password: '',
    labelPrefix: '',
    linkProfile: true,
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void call('signup:status').then(setJob).catch(() => undefined);
    return subscribe('signup:changed', (view) => {
      setJob(view);
      setNotice(null);
    });
  }, []);

  const running = Boolean(job && job.current >= 0);
  const current = job && job.current >= 0 ? job.items[job.current] : undefined;
  const set = <K extends keyof SignupRequest>(key: K, value: SignupRequest[K]) => setDraft({ ...draft, [key]: value });
  const emailCount = draft.emails.split(/[\s,;]+/).filter(Boolean).length;

  const start = async () => {
    const check = signupRequestSchema.safeParse(draft);
    if (!check.success) return setError(firstIssue(check.error));
    setError(null);
    setBusy(true);
    const view = await act(call('signup:start', draft));
    setBusy(false);
    if (view) setJob(view);
  };

  const done = async (force: boolean) => {
    setBusy(true);
    const result = await act(call('signup:done', force));
    setBusy(false);
    if (result && !result.ok) setNotice(result.message);
  };

  const close = async () => {
    if (running) await act(call('signup:cancel'));
    else if (job) await call('signup:cancel').catch(() => undefined);
    onClose();
  };

  const saved = job?.items.filter((i) => i.status === 'saved').length ?? 0;

  return (
    <Modal
      title="Create store accounts"
      icon={<UserPlus size={18} color="var(--accent)" />}
      onClose={() => void close()}
      footer={
        job ? (
          <>
            <div className="grow">
              {running ? `${job.current + 1} of ${job.items.length}` : `Finished: ${saved} account${saved === 1 ? '' : 's'} saved`}
            </div>
            {running ? (
              <>
                <Button onClick={() => void act(call('signup:skip'))} disabled={busy}>
                  Skip
                </Button>
                <Button variant="danger" onClick={() => void act(call('signup:cancel'))}>
                  Stop
                </Button>
                <Button variant="primary" onClick={() => void done(false)} disabled={busy}>
                  {busy ? 'Checking…' : 'Done, save account'}
                </Button>
              </>
            ) : (
              <Button variant="primary" onClick={() => void close()}>
                Close
              </Button>
            )}
          </>
        ) : (
          <>
            <div className="grow">{error ? <span className="danger-text">{error}</span> : null}</div>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={busy || emailCount === 0} onClick={() => void start()}>
              Start ({emailCount} email{emailCount === 1 ? '' : 's'})
            </Button>
          </>
        )
      }
    >
      {!job ? (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            For each email, a store window opens on the sign-up page with the email, a password, your name and phone filled in. You click
            the store’s <b>Create account</b> button and enter any code the store emails or texts you, then click <b>Done</b> here. The
            account is saved and starts out signed in. One at a time.
          </p>
          <div className="banner" style={{ display: 'block', fontSize: 12.5 }}>
            Use emails you can open: stores send a verification code. The app never solves CAPTCHAs, makes up emails or phone numbers, or
            skips a verification step. Store rules usually allow one account per person, and orders that break purchase limits can be
            cancelled.
          </div>
          <div className="form-grid">
            <Field label="Store">
              <select className="select" value={draft.retailer} onChange={(e) => set('retailer', e.target.value as RetailerId)}>
                {RETAILER_LIST.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Profile" help={profiles.length === 0 ? 'Create a profile first (Profiles tab).' : 'First and last name and phone come from its shipping address'}>
              <select className="select" value={draft.profileId} onChange={(e) => set('profileId', e.target.value)}>
                <option value="">Pick a profile</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.shipping.firstName} {p.shipping.lastName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Emails" className="span-all" help="One per line. Emails already saved for this store are skipped.">
              <textarea
                className="input"
                rows={5}
                value={draft.emails}
                onChange={(e) => set('emails', e.target.value)}
                placeholder={'me+target1@gmail.com\nme+target2@gmail.com'}
                style={{ resize: 'vertical', minHeight: 110 }}
              />
            </Field>
            <Field label="Password">
              <select className="select" value={draft.passwordMode} onChange={(e) => set('passwordMode', e.target.value as SignupRequest['passwordMode'])}>
                <option value="generate">A strong random one per account</option>
                <option value="same">The same one for all</option>
              </select>
            </Field>
            {draft.passwordMode === 'same' ? (
              <Field label="Password for all accounts" help="At least 8 characters; stores also want a mix of letters, digits and symbols">
                <input className="input" type="password" value={draft.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" />
              </Field>
            ) : (
              <Field label="Label prefix (optional)" help={`Accounts are named “${draft.labelPrefix.trim() || RETAILERS[draft.retailer].name} #N”`}>
                <input className="input" value={draft.labelPrefix} maxLength={40} onChange={(e) => set('labelPrefix', e.target.value)} />
              </Field>
            )}
          </div>
          <div className="toggle-row">
            <div className="text">
              <div className="title">Use this profile as each new account’s default</div>
              <div className="desc">Tasks on these accounts check out with this profile’s address and card.</div>
            </div>
            <Toggle on={draft.linkProfile} onChange={(on) => set('linkProfile', on)} label="Use this profile as default" />
          </div>
          {profiles.length === 0 ? (
            <Button small onClick={() => setTab('profiles')}>
              Open Profiles
            </Button>
          ) : null}
        </>
      ) : (
        <>
          {current ? (
            <div className="banner" style={{ display: 'block' }}>
              <b>{current.email}</b>: a {RETAILERS[job.retailer].name} window is open with the form filled in. Click the store’s Create account
              button, enter any code it sends, then click <b>Done, save account</b>. If the page isn’t the sign-up form, click the store’s
              Create account link; the form fills in when it appears.
            </div>
          ) : null}
          {notice ? (
            <div className="banner pink">
              <div className="grow">{notice}</div>
              <Button small onClick={() => void done(true)} disabled={busy}>
                Save anyway
              </Button>
            </div>
          ) : null}
          <div className="choice-list">
            {job.items.map((item, index) => (
              <div key={item.email} className={`choice ${index === job.current ? 'active' : ''}`}>
                {STATUS_ICON[item.status]}
                <div className="grow">
                  <div>{item.email}</div>
                  {item.message ? (
                    <div className="faint" style={{ fontSize: 12 }}>
                      {item.message}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
