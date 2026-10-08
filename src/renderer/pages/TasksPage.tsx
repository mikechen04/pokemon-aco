import {
  AppWindow,
  BookOpen,
  Clock,
  Copy,
  ListChecks,
  OctagonX,
  Package,
  Pencil,
  Play,
  Plus,
  Search,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { formatUsd } from '../../shared/money';
import { RETAILER_LIST, titleFromUrl } from '../../shared/retailers';
import { TASK_STATES, type TaskState, type TaskView } from '../../shared/types';
import { call } from '../api';
import { PageHeader, setDryRun } from '../App';
import { Button, confirm, EmptyState, formatWhen, IconButton, RetailerBadge, STATUS_LABELS, StatusPill } from '../components/ui';
import { act, useApp } from '../store';
import { DropReader } from './DropReader';
import { TaskForm } from './TaskForm';

type FormState = { mode: 'create'; catalogEntryId?: string } | { mode: 'edit'; task: TaskView } | null;

const IN_FLIGHT = new Set<TaskState>(['in_stock', 'queued', 'carted', 'checking_out']);

export function TasksPage() {
  const tasks = useApp((s) => s.tasks);
  const profiles = useApp((s) => s.profiles);
  const accounts = useApp((s) => s.accounts);
  const settings = useApp((s) => s.settings);
  const taskDraft = useApp((s) => s.taskDraft);
  const clearTaskDraft = useApp((s) => s.clearTaskDraft);
  const setTab = useApp((s) => s.setTab);

  const [form, setForm] = useState<FormState>(null);
  const [dropReader, setDropReader] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [retailer, setRetailer] = useState('all');
  const [status, setStatus] = useState('all');
  const [group, setGroup] = useState('all');
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!taskDraft) return;
    setForm({ mode: 'create', ...(taskDraft.catalogEntryId ? { catalogEntryId: taskDraft.catalogEntryId } : {}) });
    clearTaskDraft();
  }, [taskDraft, clearTaskDraft]);

  const groups = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tasks) if (t.groupId) map.set(t.groupId, t.groupName ?? 'Group');
    return [...map.entries()];
  }, [tasks]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks.filter((t) => {
      if (retailer !== 'all' && t.retailer !== retailer) return false;
      if (status !== 'all' && t.runtime.state !== status) return false;
      if (group !== 'all' && t.groupId !== group) return false;
      if (!q) return true;
      const hay = `${t.label ?? ''} ${t.runtime.productTitle ?? ''} ${t.input} ${t.groupName ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [tasks, retailer, status, group, query]);

  // Drop selections that are no longer visible or no longer exist.
  useEffect(() => {
    setSelected((current) => {
      const ids = new Set(visible.map((t) => t.id));
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [visible]);

  const stats = {
    total: tasks.length,
    running: tasks.filter((t) => t.runtime.running).length,
    inFlight: tasks.filter((t) => IN_FLIGHT.has(t.runtime.state)).length,
    checkedOut: tasks.filter((t) => t.runtime.state === 'checked_out').length,
    attention: tasks.filter((t) => t.runtime.state === 'paused' || t.runtime.state === 'failed').length,
  };

  const selectedIds = [...selected];
  const allVisibleSelected = visible.length > 0 && visible.every((t) => selected.has(t.id));
  const toggleAll = () => setSelected(allVisibleSelected ? new Set() : new Set(visible.map((t) => t.id)));
  const toggleOne = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const start = (ids: string[]) =>
    act(call('tasks:start', ids)).then((r) => r && useApp.getState().toast(r.ok ? 'success' : 'warn', r.message));
  const stop = (ids: string[]) => act(call('tasks:stop', ids), 'Stopped');
  const remove = async (ids: string[]) => {
    const ok = await confirm({
      title: ids.length === 1 ? 'Delete task?' : `Delete ${ids.length} tasks?`,
      message: 'Running tasks are stopped first. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) await act(call('tasks:remove', ids), (r) => r.message);
  };

  const profileName = (id: string) => profiles.find((p) => p.id === id)?.name;
  const accountOf = (id: string) => accounts.find((a) => a.id === id);

  return (
    <>
      <PageHeader
        title="Tasks"
        subtitle="Watch products in the background and check out the moment they are in stock."
        actions={
          <>
            <Button variant="primary" onClick={() => setForm({ mode: 'create' })}>
              <Plus size={16} /> New task
            </Button>
            <Button onClick={() => setDropReader(true)} title="Paste a release or restock post and let Claude set up the tasks">
              <Sparkles size={15} /> Paste drop
            </Button>
            <Button onClick={() => void act(call('tasks:startAll')).then((r) => r && useApp.getState().toast(r.ok ? 'success' : 'warn', r.message))}>
              <Play size={15} /> Start all
            </Button>
            <Button onClick={() => void act(call('tasks:stopAll'), 'Stopped all tasks')}>
              <Square size={14} /> Stop all
            </Button>
          </>
        }
      />
      <div className="page-body">
        {settings?.killSwitch ? (
          <div className="banner danger">
            <OctagonX size={18} />
            <div className="grow">Kill switch is engaged. Every task is stopped and nothing can start until you release it.</div>
            <Button small variant="danger" onClick={() => void act(call('settings:setKillSwitch', false), 'Kill switch released')}>
              Release
            </Button>
          </div>
        ) : null}
        {settings?.dryRun ? (
          <div className="banner">
            <div className="grow">
              <b>Dry run is on.</b> Tasks go all the way to the review page, verify the card, address and price, then stop
              before “Place order”.
            </div>
            <Button small variant="pink" onClick={() => void setDryRun(false)}>
              Go live
            </Button>
          </div>
        ) : null}

        <div className="stats">
          <Stat label="Tasks" value={stats.total} color="var(--text-dim)" />
          <Stat label="Running" value={stats.running} color="var(--st-monitoring)" />
          <Stat label="In stock / carting" value={stats.inFlight} color="var(--st-carted)" />
          <Stat label="Checked out" value={stats.checkedOut} color="var(--st-checked_out)" />
          <Stat label="Need attention" value={stats.attention} color="var(--st-paused)" />
        </div>

        <div className="toolbar">
          <div className="search">
            <Search size={15} />
            <input className="input" placeholder="Search tasks" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <select className="select" style={{ width: 150 }} value={retailer} onChange={(e) => setRetailer(e.target.value)}>
            <option value="all">All stores</option>
            {RETAILER_LIST.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <select className="select" style={{ width: 150 }} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">All statuses</option>
            {TASK_STATES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
          {groups.length > 0 ? (
            <select className="select" style={{ width: 190 }} value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="all">All groups</option>
              {groups.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          ) : null}
          <div className="spacer" />
          {selectedIds.length > 0 ? (
            <>
              <span className="muted">{selectedIds.length} selected</span>
              <Button small onClick={() => void start(selectedIds)}>
                <Play size={14} /> Start
              </Button>
              <Button small onClick={() => void stop(selectedIds)}>
                <Square size={13} /> Stop
              </Button>
              <Button small variant="danger" onClick={() => void remove(selectedIds)}>
                <Trash2 size={14} /> Delete
              </Button>
            </>
          ) : null}
        </div>

        {tasks.length === 0 ? (
          <div className="card">
            <EmptyState icon={<ListChecks size={22} />} title="No tasks yet">
              <div>Add a product URL, a SKU or keywords, or pick something from the catalog.</div>
              <div className="toolbar">
                <Button variant="primary" onClick={() => setForm({ mode: 'create' })}>
                  <Plus size={16} /> New task
                </Button>
                <Button onClick={() => setTab('catalog')}>
                  <BookOpen size={15} /> Open catalog
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
                    <input type="checkbox" className="check" checked={allVisibleSelected} onChange={toggleAll} aria-label="Select all" />
                  </th>
                  <th>Product</th>
                  <th>Store</th>
                  <th>Profile</th>
                  <th>Account</th>
                  <th className="num">Qty</th>
                  <th className="num">Max</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((task) => {
                  const account = accountOf(task.accountId);
                  const profile = profileName(task.profileId);
                  const rt = task.runtime;
                  const title = task.label || rt.productTitle || (task.mode === 'url' ? titleFromUrl(task.input) : null) || task.input;
                  return (
                    <tr key={task.id} className={selected.has(task.id) ? 'selected' : ''}>
                      <td>
                        <input type="checkbox" className="check" checked={selected.has(task.id)} onChange={() => toggleOne(task.id)} aria-label="Select task" />
                      </td>
                      <td>
                        <div className="product-cell">
                          <div className="thumb">{rt.imageUrl ? <img src={rt.imageUrl} alt="" /> : <Package size={18} />}</div>
                          <div style={{ minWidth: 0 }}>
                            <div className="product-title" title={title}>
                              {title}
                            </div>
                            <div className="product-sub">
                              <span className="badge">{task.mode === 'keyword' ? 'Keywords' : task.productId ?? 'URL'}</span>
                              {task.groupName ? (
                                <span className="badge pink" title={task.groupGoal ? `Stops after ${task.groupGoal} order(s)` : 'Task group'}>
                                  {task.groupName}
                                  {task.groupGoal ? ` · goal ${task.groupGoal}` : ''}
                                </span>
                              ) : null}
                              {task.startAt ? (
                                <span className="badge accent" title="Starts on its own at this time">
                                  <Clock size={11} /> {formatWhen(task.startAt)}
                                </span>
                              ) : null}
                              {(task.maxOrders ?? 1) > 1 || task.budget !== undefined || task.progress ? (
                                <span className="badge" title="Orders placed this run (keep buying) and money spent against the budget">
                                  {task.progress?.orders ?? 0}/{task.maxOrders ?? 1} orders
                                  {task.budget !== undefined ? ` · ${formatUsd(task.progress?.spent ?? 0)} of ${formatUsd(task.budget)}` : ''}
                                </span>
                              ) : null}
                              {rt.lastPrice !== undefined ? <span>{formatUsd(rt.lastPrice)}</span> : null}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <RetailerBadge id={task.retailer} />
                      </td>
                      <td>{profile ?? <span className="danger-text">Missing</span>}</td>
                      <td>
                        {account ? (
                          <div style={{ minWidth: 0 }}>
                            <div>{account.label}</div>
                            <div className="faint" style={{ fontSize: 12 }}>
                              {account.emailMasked}
                            </div>
                          </div>
                        ) : (
                          <span className="danger-text">Missing</span>
                        )}
                      </td>
                      <td className="num">{task.quantity}</td>
                      <td className="num">{formatUsd(task.maxPrice)}</td>
                      <td style={{ maxWidth: 380 }}>
                        <StatusPill runtime={rt} />
                      </td>
                      <td className="actions">
                        {rt.running ? (
                          <IconButton label="Stop" tone="stop" onClick={() => void stop([task.id])}>
                            <Square size={14} />
                          </IconButton>
                        ) : (
                          <IconButton label="Start" tone="go" onClick={() => void start([task.id])}>
                            <Play size={15} />
                          </IconButton>
                        )}
                        <IconButton
                          label={rt.handoff ? 'Open the window this task paused in' : 'Open window'}
                          tone={rt.handoff ? 'attention' : undefined}
                          onClick={() => void act(call('tasks:showWindow', task.id))}
                        >
                          <AppWindow size={15} />
                        </IconButton>
                        <IconButton label="Edit" disabled={rt.running} onClick={() => setForm({ mode: 'edit', task })}>
                          <Pencil size={14} />
                        </IconButton>
                        <IconButton label="Duplicate" onClick={() => void act(call('tasks:duplicate', task.id), 'Task duplicated')}>
                          <Copy size={14} />
                        </IconButton>
                        <IconButton label="Delete" onClick={() => void remove([task.id])}>
                          <Trash2 size={14} />
                        </IconButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visible.length === 0 ? <div className="empty">No tasks match these filters.</div> : null}
          </div>
        )}
      </div>
      {form ? (
        <TaskForm
          {...(form.mode === 'edit' ? { task: form.task } : {})}
          {...(form.mode === 'create' && form.catalogEntryId ? { catalogEntryId: form.catalogEntryId } : {})}
          onClose={() => setForm(null)}
        />
      ) : null}
      {dropReader ? <DropReader onClose={() => setDropReader(false)} /> : null}
    </>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="stat">
      <div className="value">{value}</div>
      <div className="label">
        <span className="dot" style={{ background: color }} />
        {label}
      </div>
    </div>
  );
}
