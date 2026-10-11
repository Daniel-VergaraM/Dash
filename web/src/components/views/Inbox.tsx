import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { jf, fmtDay } from '../../lib/api';
import { useListNav } from '../../lib/useListNav';
import type { ApiError, InboxItem } from '../../types';
import ConnectBox from '../ConnectBox';

interface InboxData { items: InboxItem[]; warnings: string[]; }

const SOURCE = { google: 'Task', linear: 'Linear', github: 'GitHub' } as const;

export default function Inbox({ active, vimNav, onOpenTasks }: {
  active: boolean; vimNav: boolean; onOpenTasks: () => void;
}) {
  const [data, setData] = useState<InboxData | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const { can } = useAuth();

  const load = useCallback((refresh = false) => {
    setErr(null);
    jf<InboxData>('/api/inbox' + (refresh ? '?refresh=1' : '')).then(setData).catch((e) => setErr(e as ApiError));
  }, []);

  useEffect(() => { if (active) load(); }, [active, load]);

  const items = data?.items ?? [];
  // Plain tasks have no URL of their own, so Enter on one jumps to the Tasks view.
  const open = (it: InboxItem) => {
    if (it.url) window.open(it.url, '_blank', 'noopener');
    else onOpenTasks();
  };
  const { rowRef, onKeyDown } = useListNav(items.length, vimNav);

  // Links the existing issue to a new task (no second issue is filed in Linear); the inbox
  // then drops the issue because a task now represents it.
  async function toTask(it: InboxItem) {
    if (!it.url || !it.key) return;
    setBusy(it.id); setNotice('');
    try {
      await jf('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: it.title, start: it.due || undefined, priority: it.priority || undefined,
          linearIssue: { id: it.id, url: it.url, key: it.key },
        }),
      });
      load(true);
    } catch (e) { setNotice((e as Error).message); }
    finally { setBusy(null); }
  }

  return (
    <>
      <h2>Inbox <button style={{ marginLeft: 12 }} onClick={() => load(true)}>Refresh</button></h2>
      {err ? <ConnectBox provider="google" err={err} /> : !data ? <p className="muted">Loading…</p> : (
        <div className="card">
          {notice && <p className="err small" role="alert">{notice}</p>}
          {data.warnings.map((w) => <p key={w} className="muted small" role="status">{w}</p>)}
          {items.length ? (
            <ul className="list">
              {items.map((it, i) => (
                <li
                  key={it.kind + it.id} ref={rowRef(i)} tabIndex={vimNav ? 0 : -1}
                  onKeyDown={(e) => {
                    onKeyDown(e, i);
                    if (e.key === 'Enter' && e.target === e.currentTarget) open(it);
                  }}
                >
                  <span className="tag inbox-src">{SOURCE[it.source]}</span>
                  <span className="grow">
                    {it.url
                      ? <a href={it.url} target="_blank" rel="noreferrer">{it.title}</a>
                      : <a href="#tasks" onClick={(e) => { e.preventDefault(); onOpenTasks(); }}>{it.title}</a>}
                    <div className="muted small">
                      {[it.meta, it.due && fmtDay(it.due + 'T00:00:00'), it.priority].filter(Boolean).join(' · ')}
                    </div>
                  </span>
                  {it.kind === 'issue' && it.key && can('tasks:write') && (
                    <button disabled={busy === it.id} onClick={() => toTask(it)}>Create task</button>
                  )}
                </li>
              ))}
            </ul>
          ) : <p className="muted">Nothing needs attention.</p>}
        </div>
      )}
    </>
  );
}
