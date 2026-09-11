import { useEffect, useRef, useState } from 'react';
import type { AccessData, AccessUser, Capability, Role } from '../../types';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface UserFormValues {
  name: string;
  role: Role;
  permissions: Capability[] | null;
  macs: string[];
  disabled: boolean;
  password?: string;
}

export default function UserFormModal({
  access, editing, meId, onSave, onDelete, onCancel,
}: {
  access: AccessData;
  editing: AccessUser | null;
  meId: string;
  onSave: (body: UserFormValues) => Promise<void> | void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role | 'custom'>('guest');
  const [pass, setPass] = useState('');
  const [macs, setMacs] = useState('');
  const [disabled, setDisabled] = useState(false);
  const [caps, setCaps] = useState<Set<string>>(new Set());
  const [err, setErr] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') { onCancelRef.current(); return; }
      if (e.key !== 'Tab' || !formRef.current) return;
      const focusable = formRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      prevFocus?.focus();
    };
  }, []);

  useEffect(() => {
    setName(editing?.name || '');
    const initialRole = editing?.permissions ? 'custom' : (editing?.role || 'guest');
    setRole(initialRole);
    setPass('');
    setMacs((editing?.macs || []).join(', '));
    setDisabled(!!editing?.disabled);
    setErr('');
    const held = new Set(editing?.permissions || access.roles[editing?.role || 'guest'] || []);
    setCaps(held);
  }, [editing, access.roles]);

  function onRoleChange(next: Role | 'custom') {
    setRole(next);
    if (next !== 'custom') setCaps(new Set(access.roles[next] || []));
  }

  const capsByDomain = Object.entries(access.capabilities).reduce<Record<string, [string, string][]>>(
    (groups, [cap, desc]) => {
      const domain = cap.split(':')[0];
      (groups[domain] ||= []).push([cap, desc]);
      return groups;
    }, {});

  function toggleCap(cap: string) {
    if (role !== 'custom') return;
    setCaps((prev) => {
      const next = new Set(prev);
      next.has(cap) ? next.delete(cap) : next.add(cap);
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    const custom = role === 'custom';
    const body: UserFormValues = {
      name,
      role: custom ? 'member' : role,
      permissions: custom ? [...caps] as Capability[] : null,
      macs: macs.split(',').map((s) => s.trim()).filter(Boolean),
      disabled,
    };
    if (pass) body.password = pass;
    try { await onSave(body); }
    catch (e) { setErr((e as Error).message); }
  }

  return (
    <div id="modal" className="on" onClick={(e) => (e.target as HTMLElement).id === 'modal' && onCancel()}>
      <form
        id="userForm" ref={formRef} onSubmit={submit}
        role="dialog" aria-modal="true" aria-labelledby="userFormTitle"
      >
        <h3 id="userFormTitle">{editing ? 'Edit ' + editing.name : 'Add person'}</h3>
        <label>Name<input maxLength={40} required value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
        <label>Role
          <select value={role} onChange={(e) => onRoleChange(e.target.value as Role | 'custom')}>
            <option value="admin">Admin — everything, including this panel</option>
            <option value="member">Member — everything except this panel</option>
            <option value="guest">Guest — read-only</option>
            <option value="custom">Custom — pick capabilities below</option>
          </select>
        </label>
        <label>Password <span className="muted small">
          {editing ? (editing.hasPassword ? '— leave blank to keep the current one' : '— none set') : ''}
        </span>
          <input type="password" placeholder="at least 10 characters" autoComplete="new-password"
            value={pass} onChange={(e) => setPass(e.target.value)} />
        </label>
        <label>Device MACs <span className="muted small">comma separated — these sign in without a code</span>
          <input placeholder="aa:bb:cc:dd:ee:ff" autoComplete="off" value={macs} onChange={(e) => setMacs(e.target.value)} />
        </label>
        <div id="ufCaps">
          {Object.entries(capsByDomain).map(([domain, entries]) => (
            <div className="capgroup" key={domain}>
              <div className="caphead">{domain}</div>
              {entries.map(([cap, desc]) => (
                <label key={cap}>
                  <input type="checkbox" disabled={role !== 'custom'} checked={caps.has(cap)} onChange={() => toggleCap(cap)} />
                  <span>{desc}<br /><span className="muted">{cap}</span></span>
                </label>
              ))}
            </div>
          ))}
        </div>
        <label className="rowlabel">
          <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
          Suspended (blocks sign-in, ends sessions)
        </label>
        <div className="err small">{err}</div>
        <div className="row" style={{ marginTop: 14 }}>
          <button type="submit" className="primary">Save</button>
          <button type="button" onClick={onCancel}>Cancel</button>
          {editing && editing.id !== meId && (
            <button type="button" className="danger" style={{ marginLeft: 'auto' }} onClick={onDelete}>Delete</button>
          )}
        </div>
      </form>
    </div>
  );
}
