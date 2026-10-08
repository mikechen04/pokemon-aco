import { X } from 'lucide-react';
import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { create } from 'zustand';
import { RETAILERS } from '../../shared/retailers';
import type { RetailerId, TaskRuntime, TaskState } from '../../shared/types';

type ButtonVariant = 'default' | 'primary' | 'pink' | 'danger' | 'ghost';

export function Button({
  variant = 'default',
  small,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; small?: boolean }) {
  const classes = ['btn', variant !== 'default' ? variant : '', small ? 'small' : '', className ?? ''].filter(Boolean).join(' ');
  return <button type="button" className={classes} {...props} />;
}

export function IconButton({
  label,
  tone,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tone?: 'go' | 'stop' | 'attention' }) {
  return <button type="button" className={['icon-btn', tone ?? '', className ?? ''].join(' ')} title={label} aria-label={label} {...props} />;
}

export function Field({
  label,
  help,
  error,
  ok,
  className,
  children,
}: {
  label: string;
  help?: ReactNode;
  error?: string | null;
  ok?: string | null;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`field ${className ?? ''}`}>
      <label>{label}</label>
      {children}
      {error ? <div className="error">{error}</div> : ok ? <div className="okay">{ok}</div> : help ? <div className="help">{help}</div> : null}
    </div>
  );
}

export function Toggle({
  on,
  onChange,
  pink,
  disabled,
  label,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  pink?: boolean;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      disabled={disabled}
      className={`toggle ${on ? 'on' : ''} ${pink ? 'pink' : ''}`}
      onClick={() => onChange(!on)}
    />
  );
}

export function ToggleRow({
  title,
  description,
  on,
  onChange,
  pink,
}: {
  title: string;
  description?: ReactNode;
  on: boolean;
  onChange: (next: boolean) => void;
  pink?: boolean;
}) {
  return (
    <div className="toggle-row">
      <div className="text">
        <div className="title">{title}</div>
        {description ? <div className="desc">{description}</div> : null}
      </div>
      <Toggle on={on} onChange={onChange} pink={pink} label={title} />
    </div>
  );
}

export function Modal({
  title,
  icon,
  onClose,
  footer,
  small,
  children,
}: {
  title: string;
  icon?: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  small?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${small ? 'small' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          {icon}
          <h3>{title}</h3>
          <IconButton label="Close" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

interface ConfirmRequest {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger: boolean;
  resolve: (ok: boolean) => void;
}

const useConfirmStore = create<{ request: ConfirmRequest | null; set: (r: ConfirmRequest | null) => void }>((set) => ({
  request: null,
  set: (request) => set({ request }),
}));

/** Promise-based confirmation dialog: `if (await confirm({...})) doIt()`. */
export function confirm(options: { title: string; message: ReactNode; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    useConfirmStore.getState().set({
      title: options.title,
      message: options.message,
      confirmLabel: options.confirmLabel ?? 'Confirm',
      danger: options.danger ?? false,
      resolve,
    });
  });
}

export function ConfirmHost() {
  const request = useConfirmStore((s) => s.request);
  const set = useConfirmStore((s) => s.set);
  if (!request) return null;
  const close = (ok: boolean) => {
    request.resolve(ok);
    set(null);
  };
  return (
    <Modal
      title={request.title}
      small
      onClose={() => close(false)}
      footer={
        <>
          <div className="grow" />
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant={request.danger ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus>
            {request.confirmLabel}
          </Button>
        </>
      }
    >
      <div className="muted">{request.message}</div>
    </Modal>
  );
}

/** "Today 9:00 AM", "Tomorrow 9:00 AM" or "Oct 9, 9:00 AM". */
export function formatWhen(at: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const day = (d: Date) => d.toDateString();
  const tomorrow = new Date(Date.now() + 86_400_000);
  if (day(date) === day(new Date())) return `Today ${time}`;
  if (day(date) === day(tomorrow)) return `Tomorrow ${time}`;
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

export const STATUS_LABELS: Record<TaskState, string> = {
  scheduled: 'Scheduled',
  idle: 'Idle',
  monitoring: 'Monitoring',
  in_stock: 'In stock',
  queued: 'In queue',
  carted: 'Carted',
  checking_out: 'Checking out',
  checked_out: 'Checked out',
  paused: 'Paused',
  failed: 'Failed',
};

const LIVE_STATES = new Set<TaskState>(['monitoring', 'in_stock', 'queued', 'checking_out']);

export function statusColor(state: TaskState): string {
  return `var(--st-${state})`;
}

export function StatusPill({ runtime, showMessage = true }: { runtime: TaskRuntime; showMessage?: boolean }) {
  const live = runtime.running && LIVE_STATES.has(runtime.state);
  return (
    <div className="status" style={{ ['--c' as string]: statusColor(runtime.state) }}>
      <span className="status-pill">
        <span className={`status-dot ${live ? 'live' : ''}`} />
        {STATUS_LABELS[runtime.state]}
      </span>
      {showMessage && runtime.message ? (
        <span className="status-msg" title={runtime.message}>
          {runtime.message}
        </span>
      ) : null}
    </div>
  );
}

export function RetailerBadge({ id }: { id: RetailerId }) {
  const meta = RETAILERS[id];
  return (
    <span className="badge retailer" style={{ ['--c' as string]: meta.color }}>
      {meta.name}
    </span>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="icon">{icon}</div>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/** Same artwork as build/icon.png (scripts/make-icon.mjs): the "PA" monogram. */
export function Logo({ size = 34 }: { size?: number }) {
  const a = 'M48 76L64 26L80 76M55 63h18';
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <rect width="100" height="100" rx="22" fill="#eef0f4" />
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 76V26h13a14 14 0 0 1 0 28H22" stroke="#ff94b4" strokeWidth="15" />
        <path d={a} stroke="#ffffff" strokeWidth="22" />
        <path d={a} stroke="#6aaeeb" strokeWidth="15" />
        <path d="M60 32l3.5 3.5l6.5-7" stroke="#ffffff" strokeWidth="3.2" />
      </g>
    </svg>
  );
}
