// Subtasks live here, not in Calendar extendedProperties: a checklist can exceed the
// ~1024-byte-per-field limit, and every toggle would otherwise cost a full
// read-modify-write against Google (see the PATCH /api/tasks/:id handler in server.js,
// which applies that pattern to priority/project — small enough fields to justify it).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

let dir = null;
let db = {
  subtasks: {}, // { [taskId]: [{id, title, done}] }
  tasks: {},    // { [taskId]: { time, minutes, priority, project, linearId, linearUrl, linearKey } }
};

const file = (n) => path.join(dir, n);
const save = () => fs.writeFile(file('task-meta.json'), JSON.stringify(db, null, 2));

export async function initTaskMeta(dataDir) {
  dir = dataDir;
  db = JSON.parse(await fs.readFile(file('task-meta.json'), 'utf8').catch(() => 'null')) || {};
  db.subtasks ||= {};
  db.tasks ||= {};
}

/* ---------- per-task fields Google Tasks cannot hold ---------- */

// The Tasks API stores a due DATE and discards the time of day ("it isn't possible to read
// or write the time that a task is due via the API"), and has no custom-field mechanism at
// all. Time, duration, priority, the Linear project and the issue it created therefore live
// here, keyed by the Google task id.
export const metaOf = (taskId) => db.tasks[taskId] || {};

const CLEAN = {
  time: (v) => (/^\d{2}:\d{2}$/.test(v) ? v : undefined),
  minutes: (v) => (Number.isFinite(+v) ? Math.min(Math.max(+v, 5), 1440) : undefined),
  priority: (v) => (['low', 'med', 'high'].includes(v) ? v : undefined),
  project: (v) => (v ? String(v).slice(0, 64) : undefined),
  linearId: (v) => (v ? String(v).slice(0, 64) : undefined),
  linearUrl: (v) => (/^https:\/\/linear\.app\//.test(v) ? String(v).slice(0, 300) : undefined),
  linearKey: (v) => (v ? String(v).slice(0, 32) : undefined),
};

// Passing null for a field clears it; leaving it out keeps whatever is stored.
export async function setMeta(taskId, patch) {
  const next = { ...db.tasks[taskId] };
  for (const [k, clean] of Object.entries(CLEAN)) {
    if (!(k in patch)) continue;
    if (patch[k] === null || patch[k] === '') delete next[k];
    else {
      const v = clean(patch[k]);
      if (v !== undefined) next[k] = v;
    }
  }
  if (Object.keys(next).length) db.tasks[taskId] = next;
  else delete db.tasks[taskId];
  await save();
  return next;
}

export async function deleteMeta(taskId) {
  let touched = false;
  if (db.tasks[taskId]) { delete db.tasks[taskId]; touched = true; }
  if (db.subtasks[taskId]) { delete db.subtasks[taskId]; touched = true; }
  if (touched) await save();
}

export const subtasksOf = (eventId) => db.subtasks[eventId] || [];

// Whole-list replace, not per-item CRUD: the frontend already holds the full list in
// state whenever it renders a checklist, so one PUT per change is simpler than four
// separate routes for add/toggle/rename/remove.
export async function setSubtasks(eventId, list) {
  const clean = (Array.isArray(list) ? list : [])
    .slice(0, 50)
    .map((s) => ({
      id: typeof s?.id === 'string' && s.id ? s.id : 's_' + crypto.randomBytes(4).toString('hex'),
      title: String(s?.title ?? '').trim().slice(0, 200),
      done: !!s?.done,
    }))
    .filter((s) => s.title);
  if (clean.length) db.subtasks[eventId] = clean;
  else delete db.subtasks[eventId];
  await save();
  return clean;
}

export async function deleteSubtasksFor(eventId) {
  if (db.subtasks[eventId]) { delete db.subtasks[eventId]; await save(); }
}
