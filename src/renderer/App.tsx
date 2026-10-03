import {
  Activity,
  BookOpen,
  CircleAlert,
  CircleCheck,
  Info,
  KeyRound,
  ListChecks,
  LoaderCircle,
  OctagonX,
  Settings as SettingsIcon,
  TriangleAlert,
  UserRound,
  X,
} from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { call } from './api';
import { ConfirmHost, confirm, IconButton, Logo, Toggle } from './components/ui';
import { AccountsPage } from './pages/AccountsPage';
import { CatalogPage } from './pages/CatalogPage';
import { ProfilesPage } from './pages/ProfilesPage';
import { SettingsPage } from './pages/SettingsPage';
import { TasksPage } from './pages/TasksPage';
import { UpdatesPage } from './pages/UpdatesPage';
import { act, useApp, type Tab } from './store';

const NAV: Array<{ tab: Tab; label: string; icon: ReactNode }> = [
  { tab: 'tasks', label: 'Tasks', icon: <ListChecks size={17} /> },
  { tab: 'profiles', label: 'Profiles', icon: <UserRound size={17} /> },
  { tab: 'accounts', label: 'Accounts', icon: <KeyRound size={17} /> },
  { tab: 'catalog', label: 'Catalog', icon: <BookOpen size={17} /> },
  { tab: 'updates', label: 'Updates', icon: <Activity size={17} /> },
  { tab: 'settings', label: 'Settings', icon: <SettingsIcon size={17} /> },
];

export async function setDryRun(next: boolean): Promise<void> {
  if (!next) {
    const ok = await confirm({
      title: 'Turn on live checkout?',
      message:
        'With dry run off, tasks submit real orders using the card saved on each retailer account, within each task’s max price and quantity. Make sure every profile’s card last 4 and address match the accounts.',
      confirmLabel: 'Go live',
      danger: true,
    });
    if (!ok) return;
  }
  await act(call('settings:update', { dryRun: next }), next ? 'Dry run on: orders will not be placed' : 'Live: tasks will place orders');
}

function Sidebar() {
  const tab = useApp((s) => s.tab);
  const setTab = useApp((s) => s.setTab);
  const settings = useApp((s) => s.settings);
  const info = useApp((s) => s.info);
  const tasks = useApp((s) => s.tasks);
  const accounts = useApp((s) => s.accounts);
  const running = tasks.filter((t) => t.runtime.running).length;
  const attention = accounts.filter((a) => a.session === 'needs_attention').length;
  const killed = settings?.killSwitch ?? false;
  const dryRun = settings?.dryRun ?? true;

  const toggleKill = () =>
    act(call('settings:setKillSwitch', !killed), killed ? 'Kill switch released' : 'Kill switch engaged: everything stopped');

  return (
    <aside className="sidebar">
      <div className="brand">
        <Logo />
        <div>
          <div className="brand-name">Pokemon ACO</div>
          <div className="brand-sub">TCG auto checkout</div>
        </div>
      </div>
      <nav className="nav">
        {NAV.map((item) => (
          <button key={item.tab} className={tab === item.tab ? 'active' : ''} onClick={() => setTab(item.tab)}>
            {item.icon}
            {item.label}
            {item.tab === 'tasks' && running > 0 ? <span className="count">{running}</span> : null}
            {item.tab === 'accounts' && attention > 0 ? <span className="count">{attention}</span> : null}
          </button>
        ))}
      </nav>
      <div className="sidebar-foot">
        <div className="mode-card">
          <div className="mode-row">
            <span>
              Mode:{' '}
              {dryRun ? <span className="badge accent">Dry run</span> : <span className="badge pink">Live</span>}
            </span>
            <Toggle on={!dryRun} pink onChange={(live) => void setDryRun(!live)} label="Live checkout (dry run off)" />
          </div>
          <div className="mode-row faint">{dryRun ? 'Stops before “Place order”' : 'Places real orders'}</div>
        </div>
        <button className={`kill ${killed ? 'engaged' : ''}`} onClick={() => void toggleKill()} title="Stop every task and close every automation window">
          <OctagonX size={17} />
          {killed ? 'KILL SWITCH ON' : 'KILL SWITCH'}
        </button>
        <div className="version">
          v{info?.version} · {info?.encryption.backend}
          {info && !info.encryption.strong ? ' (weak)' : ''}
        </div>
      </div>
    </aside>
  );
}

function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  const icons = {
    info: <Info size={16} color="var(--accent)" />,
    success: <CircleCheck size={16} color="var(--ok)" />,
    warn: <TriangleAlert size={16} color="var(--warn)" />,
    error: <CircleAlert size={16} color="var(--danger)" />,
  };
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`}>
          {icons[t.level]}
          <div className="msg">{t.message}</div>
          <IconButton label="Dismiss" onClick={() => dismiss(t.id)}>
            <X size={14} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}

export function App() {
  const ready = useApp((s) => s.ready);
  const loadError = useApp((s) => s.loadError);
  const tab = useApp((s) => s.tab);
  const init = useApp((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

  if (loadError) {
    return (
      <div className="loading">
        <CircleAlert size={28} color="var(--danger)" />
        <div>Could not load app data: {loadError}</div>
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="loading">
        <LoaderCircle size={26} className="spin" />
        <div>Loading…</div>
      </div>
    );
  }
  return (
    <div className="app">
      <Sidebar />
      <main className="content">
        {tab === 'tasks' && <TasksPage />}
        {tab === 'profiles' && <ProfilesPage />}
        {tab === 'accounts' && <AccountsPage />}
        {tab === 'catalog' && <CatalogPage />}
        {tab === 'updates' && <UpdatesPage />}
        {tab === 'settings' && <SettingsPage />}
      </main>
      <Toasts />
      <ConfirmHost />
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <div className="actions">{actions}</div> : null}
    </header>
  );
}
