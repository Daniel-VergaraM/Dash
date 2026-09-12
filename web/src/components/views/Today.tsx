import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { jf, fmtDay } from '../../lib/api';
import type { ApiError, CalEvent } from '../../types';
import { useListNav } from '../../lib/useListNav';
import AgendaList from '../AgendaList';
import ConnectBox from '../ConnectBox';

// Default the scheduler to the next round half-hour, in local time.
function defaultWhen() {
  const d = new Date(Math.ceil(Date.now() / 18e5) * 18e5);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export default function Today({ active, vimNav }: { active: boolean; vimNav: boolean }) {
  const { can } = useAuth();
  const [tasks, setTasks] = useState<CalEvent[] | null>(null);
  const [tasksErr, setTasksErr] = useState<ApiError | null>(null);
  const [agenda, setAgenda] = useState<CalEvent[] | null>(null);
  const [agendaErr, setAgendaErr] = useState<ApiError | null>(null);
  const [now, setNow] = useState<{ item?: any; is_playing?: boolean } | null>(null);
  const [nowErr, setNowErr] = useState<ApiError | null>(null);

  const [title, setTitle] = useState('');
  const [when, setWhen] = useState(defaultWhen);
  const [mins, setMins] = useState(30);
  const [addErr, setAddErr] = useState('');

  const loadTasks = useCallback(async () => {
    try { setTasks(await jf<CalEvent[]>('/api/events?days=30&tasks=1')); setTasksErr(null); }
    catch (e) { setTasksErr(e as ApiError); }
  }, []);

  const loadAgenda = useCallback(async () => {
    try { setAgenda(await jf<CalEvent[]>('/api/events?days=2')); setAgendaErr(null); }
    catch (e) { setAgendaErr(e as ApiError); }
  }, []);

  const loadNow = useCallback(async () => {
    try { const d = await jf<any>('/api/spotify'); setNow(d.now || {}); setNowErr(null); }
    catch (e) { setNowErr(e as ApiError); }
  }, []);

  useEffect(() => {
    if (!active) return;
    if (can('tasks:read') || can('tasks:write')) loadTasks();
    if (can('calendar:read')) loadAgenda();
    if (can('music:read')) loadNow();
  }, [active, can, loadTasks, loadAgenda, loadNow]);

  async function addTask() {
    setAddErr('');
    try {
      await jf('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ title, start: when || new Date().toISOString(), minutes: mins }),
      });
      setTitle('');
      loadTasks(); loadAgenda();
    } catch (e) { setAddErr((e as Error).message); }
  }

  async function toggleDone(id: string, done: boolean) {
    try {
      await jf('/api/tasks/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ done }) });
      loadTasks();
    } catch (e) { alert((e as Error).message); }
  }

  async function delTask(id: string, title: string) {
    if (!confirm(`Delete "${title}"?`)) return;
    try {
      await jf('/api/tasks/' + encodeURIComponent(id), { method: 'DELETE' });
      loadTasks();
    } catch (e) { alert((e as Error).message); }
  }

  async function clearCompleted() {
    const done = (tasks || []).filter((t) => t.done);
    if (!done.length) return;
    if (!confirm(`Clear ${done.length} completed task${done.length > 1 ? 's' : ''}?`)) return;
    try {
      await Promise.all(done.map((t) => jf('/api/tasks/' + encodeURIComponent(t.id), { method: 'DELETE' })));
      loadTasks();
    } catch (e) { alert((e as Error).message); }
  }

  const { rowRef, onKeyDown } = useListNav(tasks?.length ?? 0, vimNav);

  return (
    <>
      <h2>Today</h2>
      <div className="grid">
        {(can('tasks:read') || can('tasks:write')) && (
          <div className="card">
            <h3>Schedule a task</h3>
            {can('tasks:write') && (
              <div className="row" style={{ gap: 6 }}>
                <input className="grow" style={{ minWidth: 160 }} placeholder="What needs doing?"
                  value={title} onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addTask()} />
                <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
                <input type="number" min={5} step={5} title="minutes" style={{ width: 72 }}
                  value={mins} onChange={(e) => setMins(Number(e.target.value))} />
                <button className="primary" onClick={addTask}>Add</button>
              </div>
            )}
            <div className="err small" style={{ marginTop: 6 }}>{addErr}</div>
            <ul className="list" style={{ marginTop: 12 }}>
              {tasks === null ? (tasksErr ? <ConnectBox provider="google" err={tasksErr} /> : null)
                : tasks.length ? tasks.map((t, i) => (
                  <li key={t.id} ref={rowRef(i)} tabIndex={vimNav ? 0 : -1} onKeyDown={(e) => onKeyDown(e, i)}>
                    <input type="checkbox" checked={t.done} onChange={(e) => toggleDone(t.id, e.target.checked)} />
                    <span className={'grow' + (t.done ? ' done' : '')}>
                      {t.title}
                      <div className="muted small">{fmtDay(t.start)} · {t.allDay ? 'all day' : new Date(t.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
                    </span>
                    <button className="x" aria-label={`Delete "${t.title}"`} onClick={() => delTask(t.id, t.title)}>✕</button>
                  </li>
                )) : <p className="muted">No tasks yet.</p>}
            </ul>
            {tasks && tasks.some((t) => t.done) && (
              <button style={{ marginTop: 10 }} onClick={clearCompleted}>Clear completed</button>
            )}
          </div>
        )}

        {can('calendar:read') && (
          <div className="card">
            <h3>Next up</h3>
            {agenda === null
              ? (agendaErr ? <ConnectBox provider="google" err={agendaErr} /> : <p className="muted">Loading…</p>)
              : <AgendaList items={agenda} />}
          </div>
        )}

        {can('music:read') && (
          <div className="card">
            <h3>Now playing</h3>
            {now === null
              ? (nowErr ? <ConnectBox provider="spotify" err={nowErr} /> : <p className="muted">Loading…</p>)
              : now.item ? (
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <img src={now.item.album.images.at(-1)?.url || ''} alt="" width={56} height={56} style={{ borderRadius: 6 }} />
                  <div className="grow">
                    <b>{now.item.name}</b>
                    <div className="muted">{now.item.artists.map((a: any) => a.name).join(', ')}</div>
                    <div className="muted small">{now.item.album.name} · {now.is_playing ? 'playing' : 'paused'}</div>
                  </div>
                </div>
              ) : <p className="muted">Nothing playing.</p>}
          </div>
        )}
      </div>
    </>
  );
}
