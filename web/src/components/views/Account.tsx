import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { jf, ago } from '../../lib/api';
import { b64uToBuf, credToJSON, hasWebAuthn } from '../../lib/webauthn';
import { useAuth } from '../../context/AuthContext';
import type { Passkey, NotifySettings, NotificationsPayload } from '../../types';

const TIMEZONES = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

export default function Account({ active, kbdMode, onKbdModeChange, vimNav, onVimNavChange, shortcuts }: {
  active: boolean;
  kbdMode: boolean;
  onKbdModeChange: (on: boolean) => void;
  vimNav: boolean;
  onVimNavChange: (on: boolean) => void;
  shortcuts: { view: string; label: string; key: string }[];
}) {
  const webauthn = hasWebAuthn();
  const { me, refresh, can } = useAuth();
  const canNotify = can('calendar:read') || can('tasks:read') || can('tasks:write');
  const [keys, setKeys] = useState<Passkey[]>([]);
  const [pkMsg, setPkMsg] = useState<{ text: string; ok?: boolean } | null>(null);

  const [tz, setTz] = useState(me?.timezone || BROWSER_TZ);
  const [tzMsg, setTzMsg] = useState<{ text: string; ok?: boolean } | null>(null);
  useEffect(() => { setTz(me?.timezone || BROWSER_TZ); }, [me?.timezone]);

  async function saveTz() {
    setTzMsg(null);
    try {
      await jf('/api/me/timezone', { method: 'POST', body: JSON.stringify({ timezone: tz }) });
      await refresh();
      setTzMsg({ text: 'Timezone saved.', ok: true });
    } catch (e) { setTzMsg({ text: (e as Error).message }); }
  }

  const [ns, setNs] = useState<NotifySettings | null>(null);
  const [nsMsg, setNsMsg] = useState<{ text: string; ok?: boolean } | null>(null);
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );
  useEffect(() => {
    if (!active || !canNotify) return;
    jf<NotificationsPayload>('/api/notifications')
      .then((d) => setNs(d.settings))
      .catch((e) => setNsMsg({ text: (e as Error).message }));
  }, [active, canNotify]);

  async function saveNotify(e: React.FormEvent) {
    e.preventDefault();
    if (!ns) return;
    setNsMsg(null);
    try {
      setNs(await jf<NotifySettings>('/api/notifications/settings', { method: 'PUT', body: JSON.stringify(ns) }));
      setNsMsg({ text: 'Notification settings saved.', ok: true });
    } catch (err) { setNsMsg({ text: (err as Error).message }); }
  }

  // Must run from a click: browsers ignore permission prompts that are not a user gesture.
  async function enableBrowserAlerts() {
    try { setPerm(await Notification.requestPermission()); } catch { setPerm('denied'); }
  }

  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNext, setPwNext] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwMsg, setPwMsg] = useState<{ text: string; ok?: boolean } | null>(null);

  const loadKeys = useCallback(async () => {
    try { setKeys(await jf<Passkey[]>('/api/passkeys')); }
    catch (e) { setPkMsg({ text: (e as Error).message }); }
  }, []);
  useEffect(() => { if (active) loadKeys(); }, [active, loadKeys]);

  async function onPwSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPwMsg(null);
    if (pwNext !== pwConfirm) { setPwMsg({ text: 'The two new passwords do not match.' }); return; }
    try {
      await jf('/api/me/password', { method: 'POST', body: JSON.stringify({ current: pwCurrent, next: pwNext }) });
      setPwCurrent(''); setPwNext(''); setPwConfirm('');
      setPwMsg({ text: 'Password updated.', ok: true });
    } catch (e) { setPwMsg({ text: (e as Error).message }); }
  }

  async function removeKey(id: string) {
    if (!confirm('Remove this passkey?')) return;
    try { await jf('/api/passkeys/' + encodeURIComponent(id), { method: 'DELETE' }); loadKeys(); }
    catch (e) { setPkMsg({ text: (e as Error).message }); }
  }

  async function addKey() {
    setPkMsg(null);
    try {
      const label = prompt('Name this passkey (e.g. "Phone", "Laptop")') || 'Passkey';
      const options = await jf<any>('/api/passkeys/options', { method: 'POST', body: '{}' });
      const credential = await navigator.credentials.create({
        publicKey: {
          ...options,
          challenge: b64uToBuf(options.challenge),
          user: { ...options.user, id: b64uToBuf(options.user.id) },
          excludeCredentials: (options.excludeCredentials || []).map((c: any) => ({ ...c, id: b64uToBuf(c.id) })),
        },
      }) as PublicKeyCredential | null;
      if (!credential) return;
      await jf('/api/passkeys', { method: 'POST', body: JSON.stringify({ response: credToJSON(credential), label }) });
      setPkMsg({ text: 'Passkey added.', ok: true });
      loadKeys();
    } catch (e) {
      const err = e as Error;
      if (err.name === 'NotAllowedError' || err.name === 'AbortError') return;
      setPkMsg({ text: err.name === 'InvalidStateError' ? 'That device already has a passkey for this site.' : err.message });
    }
  }

  return (
    <>
      <h2>Account</h2>
      <div className="grid">
        <div className="card">
          <h3>Change your password</h3>
          <form onSubmit={onPwSubmit}>
            <input type="password" placeholder="Current password" aria-label="Current password" autoComplete="current-password"
              style={{ width: '100%', marginBottom: 8 }} value={pwCurrent} onChange={(e) => setPwCurrent(e.target.value)} />
            <input type="password" placeholder="New password" aria-label="New password" autoComplete="new-password"
              style={{ width: '100%', marginBottom: 8 }} value={pwNext} onChange={(e) => setPwNext(e.target.value)} />
            <input type="password" placeholder="Repeat new password" aria-label="Repeat new password" autoComplete="new-password"
              style={{ width: '100%', marginBottom: 10 }} value={pwConfirm} onChange={(e) => setPwConfirm(e.target.value)} />
            <button className="primary" type="submit">Update password</button>
            {pwMsg && <div className="small" role={pwMsg.ok ? 'status' : 'alert'} style={{ marginTop: 8, color: pwMsg.ok ? 'var(--good)' : 'var(--bad)' }}>{pwMsg.text}</div>}
          </form>
        </div>

        <div className="card">
          <h3>Passkeys</h3>
          <p className="muted small" style={{ marginTop: -6 }}>
            Sign in with your fingerprint, face or device PIN — no password to type or leak.
          </p>
          {keys.length ? (
            <ul className="list">
              {keys.map((k) => (
                <li key={k.id}>
                  <span className="grow">
                    <b>{k.label}</b>
                    <div className="muted small">added {ago(k.createdAt)} · {k.lastUsed ? 'last used ' + ago(k.lastUsed) : 'never used'}</div>
                  </span>
                  <button className="x" title="Remove" aria-label={`Remove passkey ${k.label}`} onClick={() => removeKey(k.id)}><X size={14} /></button>
                </li>
              ))}
            </ul>
          ) : <p className="muted">No passkeys yet.</p>}
          {webauthn
            ? <button className="primary" style={{ marginTop: 12 }} onClick={addKey}>+ Add a passkey</button>
            : <span className="muted">This browser does not support passkeys.</span>}
          {pkMsg && <div className="small" role={pkMsg.ok ? 'status' : 'alert'} style={{ marginTop: 8, color: pkMsg.ok ? 'var(--good)' : 'var(--bad)' }}>{pkMsg.text}</div>}
        </div>

        <div className="card">
          <h3>Timezone</h3>
          <p className="muted small" style={{ marginTop: -6 }}>
            Used for "today"'s day boundary and for times you type into a task without one.
          </p>
          <select
            aria-label="Timezone" value={tz} onChange={(e) => setTz(e.target.value)}
            style={{ width: '100%', marginBottom: 8 }}
          >
            {!TIMEZONES.includes(tz) && <option value={tz}>{tz}</option>}
            {TIMEZONES.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
          <button className="primary" onClick={saveTz} disabled={tz === (me?.timezone || BROWSER_TZ)}>
            Save timezone
          </button>
          {tzMsg && <div className="small" role={tzMsg.ok ? 'status' : 'alert'} style={{ marginTop: 8, color: tzMsg.ok ? 'var(--good)' : 'var(--bad)' }}>{tzMsg.text}</div>}
        </div>

        {canNotify && (
          <div className="card">
            <h3>Notifications</h3>
            <p className="muted small" style={{ marginTop: -6 }}>
              Reminders before timed events and tasks, plus an optional daily digest. They appear in the
              bell and, with browser alerts on, as system notifications — only while this tab is open.
            </p>
            {!me?.connected.google && (
              <p className="small err" role="status">Connect Google to get reminders: they come from your calendar and tasks.</p>
            )}
            {ns ? (
              <form onSubmit={saveNotify}>
                <label className="rowlabel">
                  <input type="checkbox" checked={ns.enabled} onChange={(e) => setNs({ ...ns, enabled: e.target.checked })} />
                  Enable notifications
                </label>
                <label className="small muted" style={{ display: 'block', marginTop: 10 }}>
                  Daily digest at (empty = off)
                  <input
                    type="time" value={ns.digestAt ?? ''} style={{ display: 'block', width: '100%', marginTop: 4 }}
                    onChange={(e) => setNs({ ...ns, digestAt: e.target.value || null })}
                  />
                </label>
                <label className="small muted" style={{ display: 'block', marginTop: 10 }}>
                  Remind me before
                  <select
                    value={ns.leadMin} style={{ display: 'block', width: '100%', marginTop: 4 }}
                    onChange={(e) => setNs({ ...ns, leadMin: Number(e.target.value) })}
                  >
                    {[5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m} minutes</option>)}
                    {![5, 10, 15, 30, 60].includes(ns.leadMin) && <option value={ns.leadMin}>{ns.leadMin} minutes</option>}
                  </select>
                </label>
                <div className="row" style={{ marginTop: 12 }}>
                  <button className="primary" type="submit">Save notifications</button>
                  {perm === 'default' && <button type="button" onClick={enableBrowserAlerts}>Enable browser alerts</button>}
                </div>
                <p className="muted small" style={{ marginTop: 8 }}>
                  {perm === 'granted' && 'Browser alerts are on.'}
                  {perm === 'denied' && 'Browser alerts are blocked; allow notifications for this site in your browser settings.'}
                  {perm === 'unsupported' && 'This browser does not support system notifications.'}
                </p>
              </form>
            ) : !nsMsg && <p className="muted">Loading…</p>}
            {nsMsg && <div className="small" role={nsMsg.ok ? 'status' : 'alert'} style={{ marginTop: 8, color: nsMsg.ok ? 'var(--good)' : 'var(--bad)' }}>{nsMsg.text}</div>}
          </div>
        )}

        <div className="card">
          <h3>Accessibility</h3>
          <p className="muted small" style={{ marginTop: -6 }}>
            Arrow keys already move between sidebar views. Press <b>g</b> then a letter to jump
            directly: {shortcuts.map((s, i) => (
              <span key={s.view}>{i > 0 ? ', ' : ''}<b>g {s.key}</b> {s.label}</span>
            ))}.
          </p>
          <label className="rowlabel">
            <input
              type="checkbox" checked={kbdMode}
              onChange={(e) => onKbdModeChange(e.target.checked)}
            />
            Boosted focus outlines
          </label>
          <label className="rowlabel" style={{ marginTop: 8 }}>
            <input
              type="checkbox" checked={vimNav}
              onChange={(e) => onVimNavChange(e.target.checked)}
            />
            vim/yazi list navigation (j/k, gg/G, Space, h/l)
          </label>
          <p className="muted small" style={{ marginTop: 6 }}>
            When on, inside a list — Today, Tasks, Notes, Drive, Music, Access — <b>j</b>/<b>k</b> move
            the cursor, <b>gg</b>/<b>G</b> jump to the top/bottom, <b>Space</b> toggles selection where
            a list supports it (Access), and <b>h</b>/<b>l</b> move between panes — e.g. collapse/expand
            a task's subtasks, step out of/into a Drive folder, or move from a note or playlist list
            into its editor/tracks. This is on top of the arrow-key and click navigation above, not a
            replacement.
          </p>
        </div>
      </div>
    </>
  );
}
