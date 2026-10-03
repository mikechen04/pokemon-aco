import { Activity, Bell, CircleAlert, CircleCheck, FolderOpen, Info, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LogEntry, LogLevel } from '../../shared/types';
import { call } from '../api';
import { PageHeader } from '../App';
import { Button, confirm, RetailerBadge, statusColor } from '../components/ui';
import { act, useApp } from '../store';

const LEVELS: Array<{ id: LogLevel | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'info', label: 'Info' },
  { id: 'success', label: 'Success' },
  { id: 'warn', label: 'Warnings' },
  { id: 'error', label: 'Errors' },
];

const LEVEL_ICON: Record<LogLevel, ReactNode> = {
  info: <Info size={13} color="var(--accent)" />,
  success: <CircleCheck size={13} color="var(--ok)" />,
  warn: <TriangleAlert size={13} color="var(--warn)" />,
  error: <CircleAlert size={13} color="var(--danger)" />,
};

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function UpdatesPage() {
  const logs = useApp((s) => s.logs);
  const tasks = useApp((s) => s.tasks);
  const settings = useApp((s) => s.settings);
  const setTab = useApp((s) => s.setTab);
  const [taskFilter, setTaskFilter] = useState<string>('all');
  const [level, setLevel] = useState<LogLevel | 'all'>('all');
  const [follow, setFollow] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of logs) {
      const key = entry.taskId ?? 'app';
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [logs]);

  const visible = useMemo(
    () =>
      logs.filter((entry: LogEntry) => {
        if (level !== 'all' && entry.level !== level) return false;
        if (taskFilter === 'all') return true;
        if (taskFilter === 'app') return !entry.taskId;
        return entry.taskId === taskFilter;
      }),
    [logs, level, taskFilter],
  );

  useEffect(() => {
    const el = listRef.current;
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [visible, follow]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  const label = (taskId?: string) => {
    if (!taskId) return 'App';
    const task = taskById.get(taskId);
    if (!task) return 'Deleted task';
    return task.label || task.runtime.productTitle || task.input;
  };

  const clear = async () => {
    if (await confirm({ title: 'Clear the activity log?', message: 'This clears the view. Daily log files on disk are kept for 14 days.', confirmLabel: 'Clear' })) {
      await act(call('logs:clear'));
    }
  };

  return (
    <>
      <PageHeader
        title="Updates"
        subtitle="Live activity for every task: monitoring, stock, queues, carts, checkouts and failures."
        actions={
          <>
            <Button onClick={() => void act(call('app:openPath', 'logs'))}>
              <FolderOpen size={14} /> Log files
            </Button>
            <Button onClick={() => void clear()}>
              <Trash2 size={14} /> Clear
            </Button>
          </>
        }
      />
      <div className="page-body">
        <div className="banner">
          <Bell size={17} color="var(--accent)" />
          <div className="grow">
            Desktop notifications are <b>{settings?.desktopNotifications ? 'on' : 'off'}</b>. Discord webhook is{' '}
            <b>{settings?.webhookUrl ? 'set' : 'not set'}</b>.
          </div>
          <Button small onClick={() => setTab('settings')}>
            Notification settings
          </Button>
        </div>
        <div className="log-layout">
          <div className="card log-side">
            <button className={taskFilter === 'all' ? 'active' : ''} onClick={() => setTaskFilter('all')}>
              <Activity size={14} />
              <span className="label">All activity</span>
              <span className="faint">{logs.length}</span>
            </button>
            <button className={taskFilter === 'app' ? 'active' : ''} onClick={() => setTaskFilter('app')}>
              <Info size={14} />
              <span className="label">App</span>
              <span className="faint">{counts.get('app') ?? 0}</span>
            </button>
            {tasks.map((task) => (
              <button key={task.id} className={taskFilter === task.id ? 'active' : ''} onClick={() => setTaskFilter(task.id)} title={label(task.id)}>
                <span className="status-dot" style={{ ['--c' as string]: statusColor(task.runtime.state), background: statusColor(task.runtime.state) }} />
                <span className="label">{label(task.id)}</span>
                <span className="faint">{counts.get(task.id) ?? 0}</span>
              </button>
            ))}
          </div>
          <div className="card log-main">
            <div className="toolbar" style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
              <div className="segmented">
                {LEVELS.map((l) => (
                  <button key={l.id} className={level === l.id ? 'active' : ''} onClick={() => setLevel(l.id)}>
                    {l.label}
                  </button>
                ))}
              </div>
              <div className="spacer" />
              {!follow ? (
                <Button small onClick={() => setFollow(true)}>
                  Jump to latest
                </Button>
              ) : null}
            </div>
            <div className="log-list" ref={listRef} onScroll={onScroll}>
              {visible.length === 0 ? <div className="empty">Nothing logged yet.</div> : null}
              {visible.map((entry) => (
                <div key={entry.id} className={`log-row ${entry.level}`}>
                  <span className="time">{time(entry.ts)}</span>
                  <span className="lvl">{LEVEL_ICON[entry.level]}</span>
                  <span className="who" title={label(entry.taskId)}>
                    {entry.retailer ? <RetailerBadge id={entry.retailer} /> : <span className="faint">{label(entry.taskId)}</span>}
                  </span>
                  <span className="msg">
                    {entry.taskId ? <span className="faint">{label(entry.taskId)} — </span> : null}
                    {entry.message}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
