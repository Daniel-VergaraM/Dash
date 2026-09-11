// Subtasks live here, not in Calendar extendedProperties: a checklist can exceed the
// ~1024-byte-per-field limit, and every toggle would otherwise cost a full
// read-modify-write against Google (see the PATCH /api/tasks/:id handler in server.js,
// which applies that pattern to priority/project — small enough fields to justify it).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

let dir = null;
let db = { subtasks: {} }; // { [calendarEventId]: [{id, title, done}] }

const file = (n) => path.join(dir, n);
const save = () => fs.writeFile(file('task-meta.json'), JSON.stringify(db, null, 2));

export async function initTaskMeta(dataDir) {
  dir = dataDir;
  db = JSON.parse(await fs.readFile(file('task-meta.json'), 'utf8').catch(() => 'null')) || { subtasks: {} };
  db.subtasks ||= {};
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
