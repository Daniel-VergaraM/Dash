import { useEffect, useState } from 'react';
import { jf } from '../../lib/api';
import type { ApiError, CalEvent } from '../../types';
import AgendaList from '../AgendaList';
import ConnectBox from '../ConnectBox';

export default function CalendarView({ active }: { active: boolean }) {
  const [days, setDays] = useState(14);
  const [items, setItems] = useState<CalEvent[] | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setItems(null);
    jf<CalEvent[]>('/api/events?days=' + days)
      .then((d) => { if (!cancelled) { setItems(d); setErr(null); } })
      .catch((e) => { if (!cancelled) setErr(e); });
    return () => { cancelled = true; };
  }, [active, days]);

  return (
    <>
      <h2>Calendar
        <select style={{ marginLeft: 10 }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>7 days</option>
          <option value={14}>14 days</option>
          <option value={30}>30 days</option>
        </select>
      </h2>
      {items === null
        ? (err ? <ConnectBox provider="google" err={err} /> : <p className="muted">Loading…</p>)
        : <AgendaList items={items} />}
    </>
  );
}
