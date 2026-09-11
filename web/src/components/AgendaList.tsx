import { fmtDay, fmtTime } from '../lib/api';
import type { CalEvent } from '../types';

export default function AgendaList({ items }: { items: CalEvent[] }) {
  if (!items.length) return <p className="muted">Nothing scheduled.</p>;
  const days = new Map<string, CalEvent[]>();
  for (const e of items) {
    const day = fmtDay(e.start);
    (days.get(day) ?? days.set(day, []).get(day)!).push(e);
  }
  return (
    <>
      {[...days].map(([day, evs]) => (
        <div className="daygroup" key={day}>
          <h4>{day}</h4>
          <ul className="list">
            {evs.map((e) => (
              <li key={e.id}>
                <span className="muted small" style={{ width: 74, flex: 'none' }}>{fmtTime(e.start, e.allDay)}</span>
                <span className={'grow' + (e.done ? ' done' : '')}>
                  {e.title}
                  {e.task && <span className="muted small"> · task</span>}
                  {e.location && <div className="muted small">{e.location}</div>}
                </span>
                {e.link && <a className="small" href={e.link} target="_blank" rel="noreferrer">open</a>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}
