import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { jf, ago } from '../../lib/api';
import type { AccessData, AccessUser } from '../../types';
import UserFormModal, { type UserFormValues } from './UserFormModal';

const AUDIT_LABEL: Record<string, string> = {
  signin: 'signed in', 'signin-failed': 'failed sign-in', 'user-created': 'person added',
  'user-updated': 'person updated', 'user-deleted': 'person removed',
  'provider-connected': 'connected', 'provider-disconnected': 'disconnected',
};

const EMPTY: AccessData = {
  users: [], capabilities: {} as AccessData['capabilities'],
  roles: { admin: [], member: [], guest: [] }, audit: [],
};

export default function Access({ active }: { active: boolean }) {
  const { me } = useAuth();
  const [access, setAccess] = useState<AccessData>(EMPTY);
  const [device, setDevice] = useState<{ ip: string; mac: string; local: boolean } | null>(null);
  const [editing, setEditing] = useState<AccessUser | null | undefined>(undefined); // undefined = modal closed
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setAccess(await jf<AccessData>('/api/access'));
    setDevice(await jf('/api/access/device'));
  }, []);

  useEffect(() => { if (active) load(); }, [active, load]);

  async function save(body: UserFormValues) {
    if (editing) await jf('/api/access/users/' + editing.id, { method: 'PATCH', body: JSON.stringify(body) });
    else await jf('/api/access/users', { method: 'POST', body: JSON.stringify(body) });
    setEditing(undefined);
    load();
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function bulkSetDisabled(disabled: boolean) {
    const ids = [...selected];
    if (!ids.length) return;
    const verb = disabled ? 'Suspend' : 'Unsuspend';
    if (!confirm(`${verb} ${ids.length} ${ids.length > 1 ? 'people' : 'person'}?`)) return;
    try {
      await Promise.all(ids.map((id) => jf('/api/access/users/' + id, { method: 'PATCH', body: JSON.stringify({ disabled }) })));
      setSelected(new Set());
      load();
    } catch (e) { alert((e as Error).message); }
  }

  async function remove() {
    if (!editing || !confirm('Remove ' + editing.name + '? Their sessions end immediately.')) return;
    try {
      await jf('/api/access/users/' + editing.id, { method: 'DELETE' });
      setEditing(undefined);
      load();
    } catch (e) { alert((e as Error).message); }
  }

  if (!me) return null;

  return (
    <>
      <h2>Access</h2>
      <div className="card">
        <h3>People</h3>
        <div>
          {access.users.map((u) => (
            <div className="person" key={u.id}>
              <input
                type="checkbox" checked={selected.has(u.id)} disabled={u.id === me.user.id}
                aria-label={`Select ${u.name}`} onChange={() => toggleSelect(u.id)}
              />
              <div className="avatar">{u.name[0].toUpperCase()}</div>
              <div className="grow">
                <b>{u.name}</b> {u.id === me.user.id && <span className="muted small">— you</span>}
                <span className={'tag' + (u.role === 'admin' ? ' admin' : '')}>{u.permissions ? 'custom' : u.role}</span>
                {u.disabled && <span className="tag off">suspended</span>}
                <div className="muted small">
                  {u.hasPassword ? 'password set' : 'no password'}
                  {' · '}{u.passkeys.length ? u.passkeys.length + ' passkey(s)' : 'no passkeys'}
                  {' · '}{u.macs.length ? u.macs.length + ' device(s)' : 'no devices'}
                  {' · '}{u.caps.length} of {Object.keys(access.capabilities).length} permissions
                </div>
                <div className="muted small">
                  {u.sessions.length ? u.sessions.length + ' active session(s)' : 'not signed in'}
                  {u.lastSeen ? ' · last seen ' + ago(u.lastSeen) : ''}
                </div>
              </div>
              <button onClick={() => setEditing(u)}>Edit</button>
            </div>
          ))}
        </div>
        {selected.size > 0 && (
          <div className="row" style={{ marginTop: 12 }}>
            <span className="muted small">{selected.size} selected</span>
            <button onClick={() => bulkSetDisabled(true)}>Suspend</button>
            <button onClick={() => bulkSetDisabled(false)}>Unsuspend</button>
            <button onClick={() => setSelected(new Set())}>Clear selection</button>
          </div>
        )}
        <button className="primary" style={{ marginTop: 12 }} onClick={() => setEditing(null)}>+ Add person</button>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>This device</h3>
        <div className="muted">
          {device && (
            <>
              IP <b>{device.ip || 'localhost'}</b> · MAC <b>{device.mac || 'not resolvable'}</b>
              {device.local
                ? <div className="small">This is the machine running the server, so it has no MAC of its own — {device.mac} stands in for it.</div>
                : !device.mac && <div className="small">Only devices on the same network segment can be identified by MAC.</div>}
            </>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Recent sign-in activity</h3>
        <ul className="list">
          {access.audit.length ? access.audit.map((a, i) => (
            <li key={i}>
              <span className="grow">
                {AUDIT_LABEL[a.event] || a.event} <span className="muted">{a.name || a.by || a.provider || ''}</span>
                {a.via && <span className="muted small"> · via {a.via}</span>}
                {a.ip && <span className="muted small"> · {a.ip}</span>}
              </span>
              <span className="muted small">{ago(a.at)}</span>
            </li>
          )) : <p className="muted">Nothing logged yet.</p>}
        </ul>
      </div>

      {editing !== undefined && (
        <UserFormModal
          access={access} editing={editing} meId={me.user.id}
          onSave={save} onDelete={remove} onCancel={() => setEditing(undefined)}
        />
      )}
    </>
  );
}
