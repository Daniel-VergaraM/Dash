import { useEffect, useRef, useState } from 'react';
import { jf } from '../lib/api';
import type { LinearProjectStatus, LinearTeam, Project } from '../types';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function ProjectsModal({ projects, onClose, onChange }: {
  projects: Project[]; onClose: () => void; onChange: () => void;
}) {
  const [teams, setTeams] = useState<LinearTeam[]>([]);
  const [statuses, setStatuses] = useState<LinearProjectStatus[]>([]);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#6ea8fe');
  const [teamId, setTeamId] = useState('');
  const [err, setErr] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    jf<LinearTeam[]>('/api/linear/teams').then((t) => { setTeams(t); if (t.length === 1) setTeamId(t[0].id); }).catch(() => {});
    jf<LinearProjectStatus[]>('/api/linear/statuses').then(setStatuses).catch(() => {});
  }, []);

  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') { onCloseRef.current(); return; }
      if (e.key !== 'Tab' || !formRef.current) return;
      const focusable = formRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); prevFocus?.focus(); };
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    if (!teamId) { setErr('Pick a team.'); return; }
    try {
      await jf('/api/projects', { method: 'POST', body: JSON.stringify({ name, color, teamIds: [teamId] }) });
      setName(''); onChange();
    } catch (e) { setErr((e as Error).message); }
  }
  async function patch(id: string, body: Record<string, unknown>) {
    try { await jf('/api/projects/' + id, { method: 'PATCH', body: JSON.stringify(body) }); onChange(); }
    catch (e) { alert((e as Error).message); }
  }
  const remove = async (id: string, projName: string) => {
    if (!confirm(`Delete "${projName}"? It moves to Linear's trash — restorable there, not from Dash.`)) return;
    try { await jf('/api/projects/' + id, { method: 'DELETE' }); onChange(); }
    catch (e) { alert((e as Error).message); }
  };

  return (
    <div id="modal" className="on" onClick={(e) => (e.target as HTMLElement).id === 'modal' && onClose()}>
      <form id="projectsForm" ref={formRef} role="dialog" aria-modal="true" aria-labelledby="projectsTitle" onSubmit={add}>
        <h3 id="projectsTitle">Projects</h3>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <input className="grow" placeholder="New project name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} title="Color" />
          <select value={teamId} onChange={(e) => setTeamId(e.target.value)} title="Team" required>
            <option value="">Team…</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button type="submit" className="primary">Add</button>
        </div>
        <div className="err small">{err}</div>
        <ul className="list" style={{ marginTop: 12 }}>
          {projects.length ? projects.map((p) => (
            <li key={p.id} style={{ display: 'block' }}>
              <div className="row" style={{ gap: 6 }}>
                <span className="swatch" style={{ background: p.status.color }} title={p.status.name} />
                <input className="grow" defaultValue={p.name} onBlur={(e) => e.target.value !== p.name && patch(p.id, { name: e.target.value })} />
                <select value={p.status.id} onChange={(e) => patch(p.id, { statusId: e.target.value })}>
                  {statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <input
                  type="date" value={p.targetDate || ''} title="Due date"
                  onChange={(e) => patch(p.id, { targetDate: e.target.value || null })}
                />
                <a href={p.url} target="_blank" rel="noreferrer" className="small">Open in Linear</a>
                <button type="button" className="x" aria-label={`Delete ${p.name}`} onClick={() => remove(p.id, p.name)}>✕</button>
              </div>
              <div className="row" style={{ gap: 6, marginTop: 6 }}>
                <input
                  className="grow small" placeholder="Description (optional)" defaultValue={p.description}
                  onBlur={(e) => e.target.value !== p.description && patch(p.id, { description: e.target.value })}
                />
                {p.stats && (
                  <span className="muted small" style={{ flex: 'none' }}>
                    {p.stats.done}/{p.stats.total} done
                  </span>
                )}
              </div>
            </li>
          )) : <p className="muted">No projects yet.</p>}
        </ul>
        <div className="row" style={{ marginTop: 14 }}>
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </form>
    </div>
  );
}
