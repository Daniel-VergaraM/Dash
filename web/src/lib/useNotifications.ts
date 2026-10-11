import { useCallback, useEffect, useRef, useState } from 'react';
import { jf } from './api';
import type { NotificationsPayload } from '../types';

const POLL_MS = 60_000;

// Polls the in-app notification feed and, for items that show up while the tab is in the
// background, raises a browser notification (if permitted). Background timers may be
// throttled by the browser; the visible-tab badge/panel needs no permission.
export function useNotifications(enabled: boolean) {
  const [data, setData] = useState<NotificationsPayload | null>(null);
  // null until the first load: what is already there on page open is not "new".
  const seen = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await jf<NotificationsPayload>('/api/notifications');
      const first = seen.current === null;
      const known = seen.current ?? (seen.current = new Set<string>());
      for (const n of d.items) {
        if (known.has(n.id)) continue;
        known.add(n.id);
        if (!first && !n.read && document.hidden
          && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification(n.title, { body: n.body, tag: n.key });
        }
      }
      setData(d);
    } catch { /* transient; the next poll retries */ }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    load();
    const tick = window.setInterval(load, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(tick);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, load]);

  // No ids = mark everything read.
  const markRead = useCallback(async (ids?: string[]) => {
    try {
      const r = await jf<{ unread: number }>('/api/notifications/read', {
        method: 'POST', body: JSON.stringify(ids ? { ids } : {}),
      });
      setData((d) => d && {
        ...d, unread: r.unread,
        items: d.items.map((n) => (!ids || ids.includes(n.id) ? { ...n, read: true } : n)),
      });
    } catch { /* leave the badge as is; the next poll reconciles */ }
  }, []);

  return { data, markRead };
}
