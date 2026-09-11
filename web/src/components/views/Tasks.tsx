import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { jf, fmtDay } from '../../lib/api';
import type { ApiError, CalEvent, Priority, Project, Subtask } from '../../types';
import ConnectBox from '../ConnectBox';
import ProjectsModal from '../ProjectsModal';

const PRIORITIES: Priority[] = ['high', 'med', 'low'];
const rank = (p: Priority | null) => (p ? PRIORITIES.indexOf(p) : PRIORITIES.length);

export default function Tasks({ active }: { active: boolean }) {
  const { can } = useAuth();
  const [tasks, setTasks] = useState<CalEvent[] | null>(null);
  const [tasksErr, setTasksErr] = useState<ApiError | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsErr, setProjectsErr] = useState<ApiError | null>(null);
  const [subtasks, setSubtasksState] = useState<Record<string, Subtask[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showProjects, setShowProjects] = useState(false);

  const [filterDone, setFilterDone] = useState<'all' | 'open' | 'done'>('open');
  const [filterProject, setFilterProject] = useState('all');       // 'all' | 'none' | project id
  const [filterPriority, setFilterPriority] = useState('all');     // 'all' | Priority
  const [sortBy, setSortBy] = useState<'date' | 'priority'>('date');

  const [title, setTitle] = useState('');
  const [when, setWhen] = useState('');
  const [mins, setMins] = useState(30);
  const [newPriority, setNewPriority] = useState<Priority | ''>('');
  const [newProject, setNewProject] = useState('');
  const [addErr, setAddErr] = useState('');

  const loadTasks = useCallback(async () => {
    try { setTasks(await jf<CalEvent[]>('/api/events?days=90&tasks=1')); setTasksErr(null); }
    catch (e) { setTasksErr(e as ApiError); }
  }, []);
  const loadProjects = useCallback(async () => {
    if (!can('projects:read')) return;
    try { setProjects(await jf<Project[]>('/api/projects?stats=1')); setProjectsErr(null); }
    catch (e) { setProjectsErr(e as ApiError); }
  }, [can]);

  useEffect(() => { if (active) { loadTasks(); loadProjects(); } }, [active, loadTasks, loadProjects]);

  async function addTask() {
    setAddErr('');
    try {
      await jf('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title, start: when || new Date().toISOString(), minutes: mins,
          priority: newPriority || undefined, project: newProject || undefined,
        }),
      });
      setTitle(''); setNewPriority(''); setNewProject('');
      loadTasks();
    } catch (e) { setAddErr((e as Error).message); }
  }

  async function toggleDone(id: string, done: boolean) {
    try {
      const updated = await jf<CalEvent>('/api/tasks/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ done }) });
      setTasks((prev) => (prev || []).map((t) => (t.id === id ? updated : t)));
    } catch (e) { alert((e as Error).message); }
  }
  async function delTask(id: string, taskTitle: string) {
    if (!confirm(`Delete "${taskTitle}"?`)) return;
    try { await jf('/api/tasks/' + encodeURIComponent(id), { method: 'DELETE' }); loadTasks(); }
    catch (e) { alert((e as Error).message); }
  }
  async function setPriority(id: string, priority: Priority | '') {
    try {
      const updated = await jf<CalEvent>('/api/tasks/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ priority: priority || null }) });
      setTasks((prev) => (prev || []).map((t) => (t.id === id ? updated : t)));
    } catch (e) { alert((e as Error).message); }
  }
  async function setProject(id: string, project: string) {
    try {
      const updated = await jf<CalEvent>('/api/tasks/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ project: project || null }) });
      setTasks((prev) => (prev || []).map((t) => (t.id === id ? updated : t)));
    } catch (e) { alert((e as Error).message); }
  }

  async function loadSubtasks(id: string) {
    try {
      const list = await jf<Subtask[]>('/api/tasks/' + encodeURIComponent(id) + '/subtasks');
      setSubtasksState((prev) => ({ ...prev, [id]: list }));
    } catch (e) { alert((e as Error).message); }
  }
  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else { next.add(id); if (!subtasks[id]) loadSubtasks(id); }
      return next;
    });
  }
  async function saveSubtasks(id: string, list: Subtask[]) {
    try {
      const saved = await jf<Subtask[]>('/api/tasks/' + encodeURIComponent(id) + '/subtasks', { method: 'PUT', body: JSON.stringify({ subtasks: list }) });
      setSubtasksState((prev) => ({ ...prev, [id]: saved }));
    } catch (e) { alert((e as Error).message); }
  }
  const toggleSubtaskDone = (taskId: string, subId: string) =>
    saveSubtasks(taskId, (subtasks[taskId] || []).map((s) => (s.id === subId ? { ...s, done: !s.done } : s)));
  const addSubtask = (taskId: string, t: string) =>
    saveSubtasks(taskId, [...(subtasks[taskId] || []), { id: '', title: t, done: false }]);
  const removeSubtask = (taskId: string, subId: string) =>
    saveSubtasks(taskId, (subtasks[taskId] || []).filter((s) => s.id !== subId));

  const projectName = (id: string | null) => projects.find((p) => p.id === id)?.name;

  const visible = (tasks || [])
    .filter((t) => filterDone === 'all' || (filterDone === 'done') === t.done)
    .filter((t) => filterProject === 'all' || (filterProject === 'none' ? !t.project : t.project === filterProject))
    .filter((t) => filterPriority === 'all' || t.priority === filterPriority)
    .sort((a, b) => (sortBy === 'priority' ? rank(a.priority) - rank(b.priority) : a.start.localeCompare(b.start)));

  return (
    <>
      <h2>Tasks</h2>

      {can('projects:read') && (
        projectsErr?.status === 428 ? (
          <div style={{ marginBottom: 16 }}><ConnectBox provider="linear" err={projectsErr} /></div>
        ) : (
          <div className="row" style={{ marginBottom: 16 }}>
            <button onClick={() => setShowProjects(true)}>Manage projects</button>
          </div>
        )
      )}

      <div className="grid">
        <div className="card">
          <h3>Filter & sort</h3>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <select value={filterDone} onChange={(e) => setFilterDone(e.target.value as typeof filterDone)}>
              <option value="open">Open</option>
              <option value="done">Done</option>
              <option value="all">All</option>
            </select>
            <select value={filterProject} onChange={(e) => setFilterProject(e.target.value)}>
              <option value="all">All projects</option>
              <option value="none">No project</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select value={filterPriority} onChange={(e) => setFilterPriority(e.target.value)}>
              <option value="all">All priorities</option>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
              <option value="date">Sort: date</option>
              <option value="priority">Sort: priority</option>
            </select>
          </div>
        </div>

        {can('tasks:write') && (
          <div className="card">
            <h3>New task</h3>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <input className="grow" style={{ minWidth: 160 }} placeholder="What needs doing?"
                value={title} onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addTask()} />
              <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
              <input type="number" min={5} step={5} title="minutes" style={{ width: 72 }}
                value={mins} onChange={(e) => setMins(Number(e.target.value))} />
              <select value={newPriority} onChange={(e) => setNewPriority(e.target.value as Priority | '')} title="Priority">
                <option value="">No priority</option>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              {projects.length > 0 && (
                <select value={newProject} onChange={(e) => setNewProject(e.target.value)} title="Project">
                  <option value="">No project</option>
                  {projects.filter((p) => !p.archivedAt).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              )}
              <button className="primary" onClick={addTask}>Add</button>
            </div>
            <div className="err small" style={{ marginTop: 6 }}>{addErr}</div>
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Tasks</h3>
        {tasks === null
          ? (tasksErr ? <ConnectBox provider="google" err={tasksErr} /> : <p className="muted">Loading…</p>)
          : visible.length ? (
            <ul className="list">
              {visible.map((t) => (
                <li key={t.id} style={{ display: 'block' }}>
                  <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                    <input type="checkbox" checked={t.done} onChange={(e) => toggleDone(t.id, e.target.checked)} />
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className={t.done ? 'done' : ''}>{t.title}</span>
                      <div className="muted small">
                        {fmtDay(t.start)} · {t.allDay ? 'all day' : new Date(t.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                        {t.project && projectName(t.project) ? ' · ' + projectName(t.project) : ''}
                      </div>
                    </span>
                    {can('tasks:write') && (
                      <>
                        <select value={t.priority || ''} onChange={(e) => setPriority(t.id, e.target.value as Priority | '')} title="Priority">
                          <option value="">No priority</option>
                          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                        </select>
                        {projects.length > 0 && (
                          <select value={t.project || ''} onChange={(e) => setProject(t.id, e.target.value)} title="Project">
                            <option value="">No project</option>
                            {projects.filter((p) => !p.archivedAt || p.id === t.project).map((p) => (
                              <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                          </select>
                        )}
                      </>
                    )}
                    <button onClick={() => toggleExpand(t.id)}>
                      {expanded.has(t.id) ? 'Hide subtasks' : subtasks[t.id] ? `Subtasks (${subtasks[t.id].length})` : 'Subtasks'}
                    </button>
                    <button className="x" aria-label={`Delete "${t.title}"`} onClick={() => delTask(t.id, t.title)}>✕</button>
                  </div>
                  {expanded.has(t.id) && (
                    <div style={{ paddingLeft: 30, marginTop: 8 }}>
                      {(subtasks[t.id] || []).length ? (
                        <ul className="list">
                          {subtasks[t.id].map((s) => (
                            <li key={s.id}>
                              <input type="checkbox" checked={s.done} onChange={() => toggleSubtaskDone(t.id, s.id)} />
                              <span className={'grow small' + (s.done ? ' done' : '')}>{s.title}</span>
                              <button className="x" aria-label={`Remove "${s.title}"`} onClick={() => removeSubtask(t.id, s.id)}>✕</button>
                            </li>
                          ))}
                        </ul>
                      ) : <p className="muted small">No subtasks yet.</p>}
                      <SubtaskAdder onAdd={(text) => addSubtask(t.id, text)} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : <p className="muted">No tasks match the current filter.</p>}
      </div>

      {showProjects && (
        <ProjectsModal projects={projects} onClose={() => setShowProjects(false)} onChange={loadProjects} />
      )}
    </>
  );
}

function SubtaskAdder({ onAdd }: { onAdd: (text: string) => void }) {
  const [text, setText] = useState('');
  function submit() {
    if (!text.trim()) return;
    onAdd(text.trim());
    setText('');
  }
  return (
    <div className="row" style={{ gap: 6, marginTop: 6 }}>
      <input
        className="grow small" placeholder="Add subtask" value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      <button onClick={submit}>Add</button>
    </div>
  );
}
