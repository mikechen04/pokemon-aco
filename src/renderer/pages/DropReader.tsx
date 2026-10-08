import { CheckCircle2, ClipboardPaste, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { DROP_READER_MODEL, DROP_TEXT_MAX } from '../../shared/constants';
import { formatUsd } from '../../shared/money';
import { RETAILERS } from '../../shared/retailers';
import type { DropAnalysis, DropProposal, DropSaleType, RetailerId } from '../../shared/types';
import { call } from '../api';
import { Button, formatWhen, Modal, RetailerBadge } from '../components/ui';
import { act, useApp } from '../store';
import { TaskForm, type TaskPreset } from './TaskForm';

const SALE_LABELS: Record<DropSaleType, { text: string; cls: string }> = {
  online_sale: { text: 'Online sale', cls: 'ok' },
  queue: { text: 'Waiting room', cls: 'accent' },
  draw_or_raffle: { text: 'Draw / raffle', cls: 'warn' },
  in_store_only: { text: 'In store only', cls: 'warn' },
  unknown: { text: 'Sale type unclear', cls: '' },
};

/** Tasks from a drop stop on their own this long after the start time. */
const RUN_FOR_MS = 2 * 60 * 60_000;

const EXAMPLE =
  'e.g. Prismatic Evolutions Super Premium Collection restocks at Target tomorrow at 9 AM PDT https://www.target.com/p/-/A-94300069';

export function DropReader({ onClose }: { onClose: () => void }) {
  const settings = useApp((s) => s.settings);
  const setTab = useApp((s) => s.setTab);
  const [text, setText] = useState('');
  const [reading, setReading] = useState(false);
  const [result, setResult] = useState<DropAnalysis | null>(null);
  const [preset, setPreset] = useState<{ key: string; value: TaskPreset } | null>(null);
  const [created, setCreated] = useState<Set<string>>(new Set());

  const hasKey = Boolean(settings?.anthropicApiKey);

  const read = async () => {
    setReading(true);
    const analysis = await act(call('drops:analyze', text));
    setReading(false);
    if (analysis) {
      setResult(analysis);
      setCreated(new Set());
    }
  };

  /** Keep buying up to the store's per-account limit (2 at Target), else twice. */
  const ordersFor = (retailer: RetailerId) => {
    const limit = settings?.itemLimitPerAccount[retailer] ?? 0;
    return limit > 0 ? limit : 2;
  };

  const setUp = (drop: DropProposal, retailer: RetailerId, url: string, key: string) => {
    const scheduled = retailer === drop.retailer && drop.startsAt !== null;
    setPreset({
      key,
      value: {
        retailer,
        input: url,
        label: drop.productName,
        ...(drop.catalogEntryId ? { catalogEntryId: drop.catalogEntryId } : {}),
        ...(scheduled ? { startAt: drop.startsAt!, stopAt: drop.startsAt! + RUN_FOR_MS } : {}),
        ...(drop.msrp ? { maxPrice: drop.msrp } : {}),
        maxOrders: ordersFor(retailer),
        source: `Pasted drop: ${drop.productName}${drop.timeText ? ` (${drop.timeText})` : ''}`.slice(0, 200),
      },
    });
  };

  if (preset) {
    return (
      <TaskForm
        preset={preset.value}
        onSaved={() => setCreated((keys) => new Set(keys).add(preset.key))}
        onClose={() => setPreset(null)}
      />
    );
  }

  return (
    <Modal
      title="Paste a drop"
      icon={<Sparkles size={18} color="var(--accent)" />}
      onClose={onClose}
      footer={
        <>
          <div className="grow faint" style={{ fontSize: 12 }}>
            Read by Claude ({DROP_READER_MODEL}) with your API key. Links in the post are opened to see where they lead.
          </div>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" disabled={!hasKey || reading || !text.trim()} onClick={() => void read()}>
            <ClipboardPaste size={14} /> {reading ? 'Reading…' : result ? 'Read again' : 'Read post'}
          </Button>
        </>
      }
    >
      {!hasKey ? (
        <div className="banner pink">
          <div className="grow">The drop reader needs an Anthropic API key. Add one in Settings → Drop reader.</div>
          <Button
            small
            onClick={() => {
              onClose();
              setTab('settings');
            }}
          >
            Open Settings
          </Button>
        </div>
      ) : null}
      <p className="muted" style={{ marginTop: 0 }}>
        Paste a restock or release post (Discord, X, Instagram, an email). Claude finds each product, the store and the start time.
        You review every task before it is created.
      </p>
      <textarea
        className="input"
        rows={6}
        maxLength={DROP_TEXT_MAX}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={EXAMPLE}
        style={{ resize: 'vertical', minHeight: 110 }}
      />

      {result ? (
        <>
          <div className="section-title">What Claude found</div>
          {result.summary ? <p style={{ margin: '0 0 8px' }}>{result.summary}</p> : null}
          {result.warnings.length > 0 ? (
            <div className="banner pink" style={{ display: 'block' }}>
              {result.warnings.map((w) => (
                <div key={w}>{w}</div>
              ))}
            </div>
          ) : null}
          {result.drops.length === 0 ? <div className="empty">No product release found in this post.</div> : null}
          <div className="drop-list">
            {result.drops.map((drop) => (
              <DropCard key={drop.id} drop={drop} created={created} onSetUp={setUp} />
            ))}
          </div>
          <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>
            Answered by {result.model} · {result.inputTokens.toLocaleString()} input / {result.outputTokens.toLocaleString()} output tokens
          </div>
        </>
      ) : null}
    </Modal>
  );
}

function DropCard({
  drop,
  created,
  onSetUp,
}: {
  drop: DropProposal;
  created: Set<string>;
  onSetUp: (drop: DropProposal, retailer: RetailerId, url: string, key: string) => void;
}) {
  const sale = SALE_LABELS[drop.saleType];
  const mainKey = `${drop.id}:main`;
  return (
    <div className={`drop-card ${drop.blocker ? 'blocked' : ''}`}>
      <div className="drop-head">
        <div className="grow">
          <div className="drop-name">{drop.productName}</div>
          <div className="drop-meta">
            {drop.retailer ? <RetailerBadge id={drop.retailer} /> : <span className="badge">{drop.storeName}</span>}
            <span className={`badge ${sale.cls}`}>{sale.text}</span>
            <span className="faint">
              {drop.startsAt ? formatWhen(drop.startsAt) : drop.timeText || 'No time given'}
              {drop.startsAt && drop.timeText ? ` (“${drop.timeText}”)` : ''}
            </span>
            {drop.msrp ? <span className="faint">· {formatUsd(drop.msrp)}</span> : null}
          </div>
        </div>
        {!drop.blocker && drop.retailer ? (
          created.has(mainKey) ? (
            <span className="ok-text">
              <CheckCircle2 size={14} style={{ verticalAlign: -2 }} /> Task created
            </span>
          ) : (
            <Button small variant="primary" onClick={() => onSetUp(drop, drop.retailer!, drop.url, mainKey)}>
              Set up task
            </Button>
          )
        ) : null}
      </div>
      {drop.url ? <div className="drop-url faint">{drop.url}</div> : null}
      {drop.blocker ? <div className="drop-blocker">{drop.blocker}</div> : null}
      {drop.notes ? <div className="faint" style={{ fontSize: 12.5 }}>{drop.notes}</div> : null}
      {drop.alternatives.length > 0 ? (
        <div className="drop-alts">
          <span className="faint">Your catalog also has it at</span>
          {drop.alternatives.map((alt) => {
            const key = `${drop.id}:${alt.retailer}`;
            return created.has(key) ? (
              <span key={key} className="ok-text">
                <CheckCircle2 size={13} style={{ verticalAlign: -2 }} /> {RETAILERS[alt.retailer].name}
              </span>
            ) : (
              <Button key={key} small onClick={() => onSetUp(drop, alt.retailer, alt.url, key)} title="Opens the task form; it does not use the post's start time">
                Watch at {RETAILERS[alt.retailer].name}
              </Button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
