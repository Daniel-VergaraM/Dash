import { useEffect, useRef } from 'react';
import { ago } from '../lib/api';
import type { AppNotification } from '../types';

// Popover under the bell. Escape or a click outside (the bell itself toggles) closes it.
export default function NotificationsPanel({ items, unread, onMarkRead, onMarkAll, onClose }: {
  items: AppNotification[];
  unread: number;
  onMarkRead: (id: string) => void;
  onMarkAll: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!ref.current?.contains(t) && !t?.closest('.bellwrap')) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  return (
    <div className="notifpanel" role="dialog" aria-label="Notifications" ref={ref} tabIndex={-1}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <b>Notifications</b>
        <button onClick={onMarkAll} disabled={!unread}>Mark all read</button>
      </div>
      {items.length ? (
        <ul className="list">
          {items.map((n) => (
            <li key={n.id} className={n.read ? 'read' : 'unread'}>
              <button className="notifitem grow" onClick={() => !n.read && onMarkRead(n.id)} aria-label={`${n.title}${n.read ? '' : ' (unread)'}`}>
                <b>{n.title}</b>
                {n.body && <div className="small muted">{n.body}</div>}
                <div className="small muted">{ago(n.at)}</div>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="muted small">Nothing yet.</p>}
    </div>
  );
}
