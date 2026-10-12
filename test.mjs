import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  noteName, macFromArp, taskWindow, startOfDay, searchSources, driveTerm, matches, snippet,
  prioToLinear, prioFromLinear, inboxScore, inboxOrder, issuePatch, linearLink,
  notePath, parseNote, countTasks, resolveLink, backlinksOf, rewriteLinks, filterNotes,
  localNow, dueDate, cleanNotify, dueReminders, digestDue, digestItem, parseQuick,
  sniffImage, badDims, stripJpegMeta, ASSET_NAME,
} from './lib.js';
import {
  initNotify, getSettings, setSettings, feedOf, unreadOf, markRead, push,
  sentHas, sentAdd, pruneSent, digestDateOf, setDigestDate,
} from './notify.js';
import {
  CAPABILITIES, ROLES, PASSWORD_MIN, capsOf, allows, validPassword, normalizeMac, cleanName,
  cleanPermissions, cleanTimezone, hashPassword, verifyPassword, initAuth, createUser, updateUser,
  deleteUser, signIn, userByMac, userByName, getUser, startSession, sessionUser, endSession,
  listUsers, lockedFor, recordFailure, clearFailures,
  addPasskey, removePasskey, passkeysOf, userByPasskey, touchPasskey,
} from './auth.js';
import { initTaskMeta, subtasksOf, setSubtasks, deleteSubtasksFor } from './task-meta.js';

/* ---------- lib ---------- */

// noteName is a trust boundary — it turns user input into a filesystem path.
assert.equal(noteName('ideas.md'), 'ideas.md');
assert.equal(noteName('my note (2).md'), 'my note (2).md');
for (const bad of ['../../etc/passwd', '..\\win.ini', 'x.md/../y', 'no-extension', '.hidden.md', '']) {
  assert.throws(() => noteName(bad), /bad note name/, `should reject ${bad}`);
}
assert.throws(() => noteName('/etc/passwd.md/..'), /bad note name/);
assert.equal(noteName('/tmp/deep/ok.md'), 'ok.md');

const win = ['Interface: 192.168.1.20 --- 0x5', '  Internet Address      Physical Address      Type',
  '  192.168.1.1           aa-bb-cc-dd-ee-01     dynamic',
  '  192.168.1.55          aa-bb-cc-dd-ee-02     dynamic'].join('\r\n');
assert.equal(macFromArp(win, '192.168.1.55'), 'aa:bb:cc:dd:ee:02');
assert.equal(macFromArp(win, '192.168.1.5'), null, 'must not match on prefix');
assert.equal(macFromArp('router (192.168.1.1) at aa:bb:cc:dd:ee:01 on en0', '192.168.1.1'), 'aa:bb:cc:dd:ee:01');
assert.equal(macFromArp('', '192.168.1.1'), null);

const w = taskWindow('2026-09-07T10:00:00.000Z', 45);
assert.equal(w.end, '2026-09-07T10:45:00.000Z');
assert.equal(taskWindow('2026-09-07T10:00:00.000Z').end, '2026-09-07T10:30:00.000Z');
assert.equal(taskWindow('2026-09-07T10:00:00.000Z', 1).end, '2026-09-07T10:05:00.000Z');
assert.equal(taskWindow('2026-09-07T10:00:00.000Z', 99999).end, '2026-09-08T10:00:00.000Z');
assert.throws(() => taskWindow('not a date', 30), /bad start time/);

// Naive "no timezone" strings — a raw <input type="datetime-local"> value — are interpreted in
// the given IANA zone rather than the server's own, once a user has one configured.
assert.equal(taskWindow('2026-06-01T09:00', 30, 'America/Mexico_City').start, '2026-06-01T15:00:00.000Z');
assert.equal(taskWindow('2026-06-01T09:00', 30, 'Asia/Tokyo').start, '2026-06-01T00:00:00.000Z');
// An already-absolute string is never reinterpreted, tz or not.
assert.equal(taskWindow('2026-06-01T09:00:00.000Z', 30, 'Asia/Tokyo').start, '2026-06-01T09:00:00.000Z');

// Midnight in Tokyo (UTC+9) on 2026-06-01 is 2026-05-31T15:00:00.000Z.
assert.equal(startOfDay('Asia/Tokyo', new Date('2026-06-01T10:00:00.000Z')).toISOString(), '2026-05-31T15:00:00.000Z');
// No tz falls back to the process's own local midnight — today's exact prior behavior.
{
  const now = new Date('2026-06-01T10:00:00.000Z');
  const want = new Date(now); want.setHours(0, 0, 0, 0);
  assert.equal(startOfDay(undefined, now).getTime(), want.getTime());
}

assert.equal(cleanTimezone('America/Mexico_City'), 'America/Mexico_City');
assert.equal(cleanTimezone('Not/AZone'), null);
assert.equal(cleanTimezone(null), null);
assert.equal(cleanTimezone(42), null);

/* ---------- note images ---------- */

{
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const u16 = (n) => Buffer.from([n >> 8, n & 255]);
  // Not decodable, but a structurally valid header chain: SOI, APP0, [APP1 Exif+GPS], SOF0, SOS, EOI.
  const jpeg = (w, h, exif) => Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'),
    exif ? Buffer.concat([Buffer.from([0xff, 0xe1]), u16(24), Buffer.from('Exif\0\0GPS:12.3,4.5....', 'latin1')]) : Buffer.alloc(0),
    Buffer.from([0xff, 0xc0, 0, 11, 8]), u16(h), u16(w), Buffer.from([1, 1, 0x11, 0]),
    Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0]), Buffer.from([1, 2, 3]), Buffer.from([0xff, 0xd9]),
  ]);
  const gif = (w, h) => Buffer.concat([Buffer.from('GIF89a'), Buffer.from([w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0, 0x3b])]);
  const webp = Buffer.from('524946461200000057454250' + '5650384c05000000' + '2f00000000' + '00', 'hex'); // VP8L 1x1 + pad
  const dim = (b) => { const s = sniffImage(b); return s && [s.type, s.width, s.height]; };

  assert.deepEqual(dim(PNG), ['image/png', 1, 1]);
  assert.deepEqual(dim(jpeg(30, 20)), ['image/jpeg', 30, 20]);
  assert.deepEqual(dim(gif(7, 9)), ['image/gif', 7, 9]);
  assert.deepEqual(dim(webp), ['image/webp', 1, 1]);
  assert.equal(sniffImage(PNG).ext, 'png');
  assert.equal(sniffImage(jpeg(1, 1)).ext, 'jpg');

  // Things that are not one of the four formats, or only dress up as one.
  for (const [what, b] of [
    ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>')],
    ['html', Buffer.from('<!doctype html><script>alert(1)</script>')],
    ['script as png', Buffer.from('<script>alert(document.cookie)</script>')],
    ['text', Buffer.from('hello world, definitely not an image')],
    ['bmp', Buffer.from('BM' + 'x'.repeat(60))],
    ['empty', Buffer.alloc(0)],
    ['not a buffer', 'GIF89a'],
  ]) assert.equal(sniffImage(b), null, what);

  // Right magic, wrong everything else: recognised but flagged unusable (no dimensions).
  assert.ok(badDims(sniffImage(PNG.subarray(0, 20))), 'truncated png');
  assert.ok(badDims(sniffImage(Buffer.concat([PNG, Buffer.from('<script>')]))), 'png with appended payload');
  assert.ok(badDims(sniffImage(Buffer.concat([gif(1, 1), Buffer.from('<script>alert(1)</script>')]))), 'gif+html polyglot');
  assert.ok(badDims(sniffImage(Buffer.concat([webp, Buffer.from('<script>alert(1)</script>')]))), 'webp+html');
  assert.ok(badDims(sniffImage(Buffer.concat([Buffer.from('GIF89a'), Buffer.from('<script>alert(1)</script>')]))), 'GIF header over html');
  assert.ok(badDims(sniffImage(jpeg(10, 10).subarray(0, 30))), 'truncated jpeg');
  assert.ok(badDims(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0]))), 'jpeg segment past the end');
  for (let n = 12; n < PNG.length; n++) sniffImage(PNG.subarray(0, n)); // never throws on any prefix
  for (let n = 12; n < 60; n++) { sniffImage(jpeg(5, 5, true).subarray(0, n)); sniffImage(webp.subarray(0, n)); }

  // Dimension ceilings: 0 px, > 8000 per side, > 40 MP.
  assert.equal(badDims({ width: 8000, height: 5000 }), '');
  assert.ok(badDims({ width: 8001, height: 1 }));
  assert.ok(badDims({ width: 7000, height: 7000 }), '49 MP');
  assert.ok(badDims({ width: 0, height: 10 }));
  assert.ok(badDims(sniffImage(jpeg(60000, 60000))));

  // EXIF/XMP is stripped and what remains still sniffs the same.
  const withExif = jpeg(30, 20, true);
  const clean = stripJpegMeta(withExif);
  assert.ok(withExif.includes('GPS:12.3') && !clean.includes('GPS:12.3') && !clean.includes('Exif'));
  assert.deepEqual(dim(clean), ['image/jpeg', 30, 20]);
  assert.equal(clean.length, withExif.length - 26);
  assert.equal(stripJpegMeta(jpeg(1, 1)).equals(jpeg(1, 1)), true);
  assert.equal(stripJpegMeta(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 4])), null, 'no SOS: refused, not stored raw');

  // The name is the only thing the server will look up on disk.
  const id = 'a'.repeat(32);
  for (const ok of [`${id}.png`, `${id}.jpg`, `${id}.jpeg`, `${id}.gif`, `${id}.webp`]) assert.ok(ASSET_NAME.test(ok), ok);
  for (const bad of ['../x.png', `../${id}.png`, '..%2f..%2fx.png', 'a/b.png', `${id.toUpperCase()}.png`, `${id}.PNG`,
    `${id}.png.html`, `${id}.html`, `${id}.svg`, `${id}.png\0`, `${id}.png\n`, `${'a'.repeat(31)}.png`, `${'a'.repeat(33)}.png`,
    `${'g'.repeat(32)}.png`, '%2e%2e', '..', '.', `${id}`, `.${id}.png`, `${id}.png/`]) {
    assert.equal(ASSET_NAME.test(bad), false, JSON.stringify(bad));
  }
}

/* ---------- quick capture ---------- */

{
  // Sunday 2026-10-11 10:00 in Bogota (UTC-5); in Tokyo it is already Monday 2026-10-12 00:00.
  const now = new Date('2026-10-11T15:00:00Z');
  const P = [{ id: 'p1', name: 'Dash' }, { id: 'p2', name: 'Dashboard Ops' }, { id: 'p3', name: 'Cámara' }];
  const q = (t, o = {}) => parseQuick(t, { now, tz: 'America/Bogota', projects: P, ...o });
  const due = (t, o) => q(t, o).due;

  assert.deepEqual(q('mañana 3pm revisar PR !dash p1'), {
    title: 'revisar PR', due: '2026-10-12T15:00', hasTime: true, priority: 'high',
    project: { id: 'p1', name: 'Dash' }, duration: null, warnings: [],
  });
  assert.equal(due('hoy x'), '2026-10-11');
  assert.equal(due('TODAY x'), '2026-10-11');
  assert.equal(due('Tomorrow x'), '2026-10-12');
  assert.equal(due('pasado mañana x'), '2026-10-13');
  assert.equal(due('pasado manana x'), '2026-10-13');
  assert.equal(due('x'), null);
  assert.equal(due('hoy x', { tz: 'Asia/Tokyo' }), '2026-10-12', 'today is read in the user zone');

  // Every weekday, strictly after Sunday 2026-10-11: the current weekday means next week.
  const week = {
    lunes: 12, martes: 13, miercoles: 14, miércoles: 14, jueves: 15, viernes: 16, sabado: 17, sábado: 17, domingo: 18,
    monday: 12, tuesday: 13, wednesday: 14, thursday: 15, friday: 16, saturday: 17, sunday: 18,
    mon: 12, tue: 13, wed: 14, thu: 15, fri: 16, sat: 17, sun: 18,
  };
  for (const [w, d] of Object.entries(week)) assert.equal(due(`x ${w}`), `2026-10-${d}`, w);
  assert.equal(due('este viernes x'), '2026-10-16');
  assert.equal(due('next friday x'), '2026-10-16');
  assert.equal(due('Próximo Lunes x'), '2026-10-12');
  assert.equal(q('x next friday').title, 'x');
  assert.equal(due('hoy es domingo y escribo domingo', { tz: 'Asia/Tokyo' }), '2026-10-12', 'Monday in Tokyo: "domingo" is the 18th, hoy wins');
  assert.equal(due('lunes', { tz: 'Asia/Tokyo' }), '2026-10-19', 'Monday in Tokyo -> next week');
  assert.equal(q('x domingo y domingo').title, 'x y domingo', 'only the first date counts');

  assert.equal(due('en 3 días x'), '2026-10-14');
  assert.equal(due('in 1 day x'), '2026-10-12');
  assert.equal(due('en 2 semanas x'), '2026-10-25');
  assert.equal(due('in 2 weeks x'), '2026-10-25');
  assert.equal(due('en 5 x'), null, 'no unit, no date');
  assert.equal(due('x 2026-12-31'), '2026-12-31');
  assert.equal(due('x 2026-02-30'), null, 'impossible ISO date stays text');
  assert.equal(due('x 25/12'), '2026-12-25');
  assert.equal(due('x 5-11'), '2026-11-05');
  assert.equal(due('x 10/10'), '2027-10-10', 'already passed -> next year');
  assert.equal(due('x 11/10'), '2026-10-11', 'today stays this year');
  assert.equal(due('x 31/2'), null);
  assert.equal(due('x 29/2'), '2028-02-29', '29/2 rolls to the next leap year');
  assert.equal(due('x 29/2', { now: new Date('2028-03-01T12:00:00Z') }), '2032-02-29');
  assert.equal(q('x 29/2').title, 'x');
  for (const bad of ['31/2', '0/5', '13/13', '32/1']) {
    const r = q(`x ${bad}`);
    assert.deepEqual([r.due, r.title, r.warnings.length], [null, `x ${bad}`, 1], bad);
    assert.match(r.warnings[0], /no válida/);
  }
  assert.deepEqual(q('x !dash', { projects: [], projectsFailed: true }).warnings, ['No se pudieron cargar los proyectos de Linear']);
  assert.equal(q('x !dash', { projects: [], projectsFailed: true }).project, null);
  // Unclosed quote: literal, neither a delimiter nor glued to the next word.
  assert.equal(q('x "mañana').due, '2026-10-12');
  assert.equal(q('x "mañana').title, 'x "');
  assert.equal(q('"a b" y "c').title, 'a b y " c');

  for (const [t, hm] of [['3pm', '15:00'], ['3:30pm', '15:30'], ['15:00', '15:00'], ['12am', '00:00'], ['12pm', '12:00'],
    ['a las 3pm', '15:00'], ['a las 15', '15:00'], ['a las 9:30', '09:30'], ['at 3pm', '15:00'], ['at 3 pm', '15:00'], ['a la 1pm', '13:00']]) {
    const r = q(`x mañana ${t}`);
    assert.deepEqual([r.due, r.hasTime, r.title], [`2026-10-12T${hm}`, true, 'x'], t);
  }
  assert.equal(q('x mañana').hasTime, false);
  assert.equal(due('x 13pm'), null);
  assert.equal(due('x 25:00'), null);
  assert.equal(due('x 15'), null, 'a bare number is not a time');
  for (const [t, hm] of [['15h', '15:00'], ['a las 15h', '15:00'], ['9h', '09:00'], ['23h', '23:00']]) assert.equal(q(`x mañana ${t}`).due, `2026-10-12T${hm}`, t);
  assert.equal(q('reunión 15h mañana').duration, null);
  assert.equal(q('reunión 15h mañana').due, '2026-10-12T15:00');
  for (const [t, n] of [['2h', 120], ['8h', 480], ['1.5h', 90], ['12.5h', 750], ['15 horas', null], ['15horas', 900]]) assert.equal(q(`x ${t}`).duration, n, t);
  assert.equal(q('x 15').title, 'x 15');
  assert.equal(due('x 11:00'), '2026-10-11T11:00', 'later today');
  assert.equal(due('x 10:00'), '2026-10-12T10:00', 'not strictly later: tomorrow');
  assert.equal(due('x 9am'), '2026-10-12T09:00', 'already passed: tomorrow');
  assert.equal(due('x 9am', { tz: 'Asia/Tokyo' }), '2026-10-12T09:00', 'Tokyo is at 00:00, so 9am is still ahead');

  assert.deepEqual(q('x !cam').project, { id: 'p3', name: 'Cámara' });
  assert.deepEqual(q('x !CAMARA').project, { id: 'p3', name: 'Cámara' });
  assert.deepEqual(q('x !dashb').project, { id: 'p2', name: 'Dashboard Ops' });
  assert.deepEqual(q('x !dash').project, { id: 'p1', name: 'Dash' }, 'exact beats longer prefix');
  assert.deepEqual(q('x !dash').warnings, []);
  assert.deepEqual(q('x !das').project, { id: 'p1', name: 'Dash' }, 'ambiguous: shortest wins');
  assert.equal(q('x !das').warnings.length, 1);
  assert.deepEqual(q('x !dashboardops').project, { id: 'p2', name: 'Dashboard Ops' });
  {
    const r = q('x !nope');
    assert.deepEqual([r.project, r.title, r.warnings.length], [null, 'x', 1]);
    assert.match(r.warnings[0], /!nope/);
    assert.equal(q('x !dash', { projects: [] }).project, null);
  }
  assert.deepEqual([q('p1 x').priority, q('x P2').priority, q('x p3').priority], ['high', 'med', 'low']);
  assert.equal(q('x p4').priority, null);
  assert.equal(q('x p4').title, 'x p4');
  for (const [t, n] of [['30m', 30], ['1h', 60], ['45min', 45], ['1.5h', 90], ['1,5h', 90], ['2', null]]) {
    assert.equal(q(`x ${t}`).duration, n, t);
  }
  assert.equal(q('x 2m').duration, null, 'below the 5 minute floor');
  assert.equal(q('x 30m').title, 'x');

  assert.equal(q('"mañana 3pm !dash p1" hoy').title, 'mañana 3pm !dash p1');
  assert.equal(q('"mañana 3pm !dash p1" hoy').due, '2026-10-11');
  assert.deepEqual([q('"mañana 3pm"').due, q('"mañana 3pm"').project], [null, null]);
  assert.equal(q('revisar "p1" ahora p2').title, 'revisar p1 ahora');
  assert.equal(q('mañana p1').title, '');
  assert.ok(q('mañana p1').warnings.includes('Title is empty'));
  assert.equal(q('').title, '');
  assert.equal(q('   ').due, null);
  assert.equal(q('! hola').title, '! hola');
  assert.equal(q('p10 hola').title, 'p10 hola');
  assert.equal(q('p10 hola').priority, null);
  assert.equal(q('mañanas pasadomañana tomorrowland hoyo').due, null);
  assert.equal(q('mañanas pasadomañana tomorrowland hoyo').title, 'mañanas pasadomañana tomorrowland hoyo');
  assert.equal(q('MAÑANA, MANANA 3PM x').title, 'MANANA x', 'case and accents do not matter; first date wins');
  assert.equal(q('Revisar PR del Módulo').title, 'Revisar PR del Módulo');
  assert.equal(q('x en 2 dias y !dash p1 30m a las 4pm').title, 'x y');
}

/* ---------- due date for Google Tasks ---------- */

{
  // Naive local strings keep their own date; late/early hours must not drift by the UTC offset.
  assert.equal(dueDate('2026-10-12T23:00', 'America/Bogota'), '2026-10-12');
  assert.equal(dueDate('2026-10-12T08:00', 'Asia/Tokyo'), '2026-10-12');
  assert.equal(dueDate('2026-10-12T09:00', 'Pacific/Auckland'), '2026-10-12');
  assert.equal(dueDate('2026-10-12T00:30', 'America/Bogota'), '2026-10-12');
  assert.equal(dueDate('2026-10-12', 'Asia/Tokyo'), '2026-10-12', 'date only passes through');
  // Absolute instants are read in the user's zone.
  assert.equal(dueDate('2026-10-13T04:00:00.000Z', 'America/Bogota'), '2026-10-12');
  assert.equal(dueDate('2026-10-12T23:00:00Z', 'Asia/Tokyo'), '2026-10-13');
  assert.equal(dueDate('2026-10-12T05:00:00Z', 'Pacific/Auckland'), '2026-10-12');
  assert.equal(dueDate('2026-10-12T23:00:00-05:00', 'America/Bogota'), '2026-10-12');
  assert.equal(dueDate('2026-10-12T23:00:00+13:00', 'Pacific/Auckland'), '2026-10-12');
  assert.throws(() => dueDate('nope', 'Asia/Tokyo'), /bad start time/);
}

/* ---------- input cleaning ---------- */

assert.equal(PASSWORD_MIN, 10);
for (const ok of ['correct horse battery', 'a'.repeat(10), 'a'.repeat(200)]) assert.ok(validPassword(ok));
for (const bad of ['short', 'a'.repeat(9), 'a'.repeat(201), '', null, undefined, 1234567890]) {
  assert.equal(validPassword(bad), false, `should reject password ${JSON.stringify(bad)}`);
}

assert.equal(normalizeMac('AA-BB-CC-DD-EE-FF'), 'aa:bb:cc:dd:ee:ff');
assert.equal(normalizeMac('aabbccddeeff'), 'aa:bb:cc:dd:ee:ff');
assert.equal(normalizeMac('aa:bb:cc:dd:ee'), null);
assert.equal(normalizeMac('nonsense'), null);

assert.equal(cleanName('  Ana   María  '), 'Ana María');
assert.equal(cleanName('x'), null);
assert.equal(cleanName('a'.repeat(200)).length, 40);

// Unknown capabilities are dropped rather than trusted.
assert.deepEqual(cleanPermissions(['notes:read', 'root:everything']), ['notes:read']);
assert.equal(cleanPermissions(null), null, 'null means inherit from role');
assert.equal(cleanPermissions('notes:read'), null, 'a non-array is not a permission set');

/* ---------- roles and capabilities ---------- */

assert.ok(ROLES.admin.includes('users:manage'));
assert.ok(!ROLES.member.includes('users:manage'), 'members must not manage access');
assert.ok(!ROLES.guest.some((c) => c.endsWith(':write') || c.endsWith(':manage')), 'guests are read-only');
assert.equal(ROLES.admin.length, Object.keys(CAPABILITIES).length);
assert.ok(!ROLES.member.includes('projects:write') && !ROLES.member.includes('projects:read'), 'projects are admin-only by default');
assert.ok(!ROLES.member.includes('github:read'), 'github is admin-only by default');
assert.ok(!ROLES.guest.includes('projects:read') && !ROLES.guest.includes('github:read'));
assert.deepEqual(capsOf({ role: 'admin', permissions: ['projects:read'] }), ['projects:read'], 'per-person override still grants an admin-only cap');

assert.deepEqual(capsOf({ role: 'guest' }), ROLES.guest);
assert.deepEqual(capsOf({ role: 'admin', permissions: ['notes:read'] }), ['notes:read'], 'override beats role');
assert.deepEqual(capsOf({ role: 'admin', disabled: true }), [], 'suspended people hold nothing');
assert.deepEqual(capsOf(null), []);
assert.ok(allows({ role: 'member' }, 'notes:write'));
assert.ok(allows({ role: 'guest' }, 'notes:write', 'notes:read'), 'any-of semantics');
assert.ok(!allows({ role: 'guest' }, 'notes:write'));

/* ---------- password hashing ---------- */

const PW = 'correct horse battery staple';
const h = await hashPassword(PW);
assert.ok(h.startsWith('scrypt:'));
assert.ok(!h.includes(PW), 'the password must never appear in its own hash');
assert.notEqual(h, await hashPassword(PW), 'salting makes two hashes of one password differ');
assert.ok(await verifyPassword(PW, h));
assert.ok(!(await verifyPassword(PW + 'x', h)));
assert.ok(!(await verifyPassword(PW, 'garbage')));
assert.ok(!(await verifyPassword(PW, null)));
await assert.rejects(() => hashPassword('short'), /at least 10/);

/* ---------- the store, end to end ---------- */

const OWNER_PW = 'owner passphrase one';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-auth-'));
await initAuth(dir, OWNER_PW);

const owner = await signIn('Owner', OWNER_PW);
assert.ok(owner, 'bootstrap admin signs in with the ACCESS_PASSWORD');
assert.equal(owner.role, 'admin');
assert.equal(listUsers()[0].passwordHash, undefined, 'hashes must never leave the module');
assert.equal(listUsers()[0].hasPassword, true);

// Names identify the account, so the lookup is case-insensitive but must stay unique.
assert.equal(userByName('owner').id, owner.id);
assert.equal(await signIn('OWNER', OWNER_PW).then((u) => u.id), owner.id);
await assert.rejects(() => createUser({ name: 'owner', password: 'another passphrase' }),
  /already has that name/);

const GUEST_PW = 'guest passphrase two';
const guest = await createUser({
  name: 'Guest', role: 'guest', password: GUEST_PW, macs: ['AA-BB-CC-DD-EE-01'],
});
assert.deepEqual(guest.macs, ['aa:bb:cc:dd:ee:01']);
assert.equal(guest.timezone, null, 'unset by default');
await updateUser(guest.id, { timezone: 'Europe/Madrid' });
assert.equal(getUser(guest.id).timezone, 'Europe/Madrid');
await updateUser(guest.id, { timezone: 'Not/AZone' });
assert.equal(getUser(guest.id).timezone, null, 'an invalid zone clears rather than sticking');
await updateUser(guest.id, { timezone: null });
assert.equal((await signIn('Guest', GUEST_PW)).id, guest.id);
assert.equal(await signIn('Guest', 'wrong passphrase here'), null);
assert.equal(await signIn('Nobody', GUEST_PW), null, 'an unknown name must not sign anyone in');
assert.equal(userByMac('aa:bb:cc:dd:ee:01').id, guest.id);
assert.equal(userByMac('ff:ff:ff:ff:ff:ff'), null);
await assert.rejects(() => createUser({ name: 'Ghost', role: 'guest' }), /needs a password/);
await assert.rejects(() => createUser({ name: 'Bad', role: 'wizard', password: PW }), /unknown role/);
await assert.rejects(() => createUser({ name: 'Weak', password: 'short' }), /at least 10/);

/* ---------- passkeys ---------- */

const KEY = { id: 'cred-aaa', publicKey: 'cHVia2V5', counter: 0, transports: ['internal'], label: 'Phone' };
await addPasskey(guest.id, KEY);
assert.equal(passkeysOf(guest.id).length, 1);
assert.equal(userByPasskey('cred-aaa').user.id, guest.id);
assert.equal(userByPasskey('cred-nope'), null);
await assert.rejects(() => addPasskey(guest.id, KEY), /already registered/);

// The public key never leaves the module with the rest of the record.
assert.equal(listUsers().find((u) => u.id === guest.id).passkeys[0].publicKey, undefined);
assert.equal(listUsers().find((u) => u.id === guest.id).passkeys[0].label, 'Phone');

// The counter is what detects a cloned authenticator later, so it has to be stored.
await touchPasskey('cred-aaa', 7);
assert.equal(passkeysOf(guest.id)[0].counter, 7);
assert.ok(passkeysOf(guest.id)[0].lastUsed);

// A suspended person's passkey must not resolve.
await updateUser(guest.id, { disabled: true });
assert.equal(userByPasskey('cred-aaa'), null, 'a suspended person cannot sign in with a passkey');
await updateUser(guest.id, { disabled: false });

// A passkey alone is a valid way in, so the password and the device may both be dropped...
await updateUser(guest.id, { clearPassword: true, macs: [] });
assert.equal(await signIn('Guest', GUEST_PW), null, 'a cleared password stops working');
assert.equal(userByMac('aa:bb:cc:dd:ee:01'), null, 'and the device no longer resolves');
// ...but then it is the only one left, and removing it would lock the account out.
await assert.rejects(() => removePasskey(guest.id, 'cred-aaa'), /only way in/);
assert.equal(passkeysOf(guest.id).length, 1, 'a rejected removal must leave the passkey in place');
await assert.rejects(() => removePasskey(guest.id, 'cred-nope'), /no such passkey/);

await updateUser(guest.id, { password: GUEST_PW });
await removePasskey(guest.id, 'cred-aaa');
assert.equal(passkeysOf(guest.id).length, 0);

/* ---------- sessions ---------- */

const sid = await startSession(guest, 'password', '10.0.0.9');
assert.equal(sessionUser(sid).user.id, guest.id);
await updateUser(guest.id, { disabled: true });
assert.equal(sessionUser(sid), null, 'suspending must invalidate live sessions');
assert.equal(await signIn('Guest', GUEST_PW), null, 'a suspended person cannot sign in');
await updateUser(guest.id, { disabled: false });

const sid2 = await startSession(guest, 'passkey', '10.0.0.9');
await endSession(sid2);
assert.equal(sessionUser(sid2), null);

/* ---------- the last-admin guard ---------- */

await assert.rejects(() => updateUser(owner.id, { role: 'guest' }), /nobody able to manage access/);
assert.equal(owner.role, 'admin', 'a rejected edit must leave nothing half-applied');
await assert.rejects(() => updateUser(owner.id, { name: 'x' }), /2-40 characters/);
assert.equal(owner.name, 'Owner', 'a rejected edit must not rename either');
await assert.rejects(() => deleteUser(owner.id), /nobody able to manage access/);
await deleteUser(guest.id);
assert.equal(listUsers().length, 1);

// Rotating a password invalidates the old one.
const NEW_PW = 'owner passphrase three';
await updateUser(owner.id, { password: NEW_PW });
assert.equal(await signIn('Owner', OWNER_PW), null);
assert.equal((await signIn('Owner', NEW_PW)).id, owner.id);

/* ---------- rate limiting ---------- */

const ip = '10.0.0.42';
assert.equal(lockedFor(ip), 0);
for (let i = 0; i < 5; i++) recordFailure(ip);
assert.ok(lockedFor(ip) > 0, 'five failures locks the address out');
clearFailures(ip);
assert.equal(lockedFor(ip), 0);

/* ---------- persistence ---------- */

await initAuth(dir, OWNER_PW);
assert.equal(listUsers().length, 1, 'a second init must not create another bootstrap admin');
assert.equal((await signIn('Owner', NEW_PW)).id, owner.id);

await fs.rm(dir, { recursive: true, force: true });

/* ---------- migration from the old 6-digit codes ---------- */

// Records written before the switch stored the hash under `codeHash`. scrypt does not care
// what the input was, so the old credential has to keep working after the rename.
const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-legacy-'));
await fs.writeFile(path.join(legacyDir, 'auth.json'), JSON.stringify({
  users: [{
    id: 'u_legacy', name: 'Old', role: 'admin', permissions: null, macs: [],
    codeHash: await hashPassword('424242 was a code'), disabled: false, createdAt: 1, lastSeen: null,
  }],
  sessions: {},
}));
await initAuth(legacyDir, OWNER_PW);
assert.equal(listUsers().length, 1, 'the migrated admin counts, so no bootstrap admin is added');
assert.ok(await signIn('Old', '424242 was a code'), 'the old credential still opens the account');
assert.equal(getUser('u_legacy').codeHash, undefined, 'codeHash is gone once migrated');
assert.deepEqual(passkeysOf('u_legacy'), [], 'older records gain an empty passkey list');
await fs.rm(legacyDir, { recursive: true, force: true });

/* ---------- subtasks store, end to end ---------- */

const tmDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-taskmeta-'));
await initTaskMeta(tmDir);
assert.deepEqual(subtasksOf('evt1'), []);

const list = await setSubtasks('evt1', [{ title: 'Buy tiles' }, { title: 'Call plumber', done: true }]);
assert.equal(list.length, 2);
assert.ok(list[0].id.startsWith('s_'));
assert.equal(subtasksOf('evt1').length, 2);

const capped = await setSubtasks('evt1', Array.from({ length: 60 }, (_, i) => ({ title: 'item ' + i })));
assert.equal(capped.length, 50, 'subtask lists are capped at 50');

await setSubtasks('evt1', []);
assert.deepEqual(subtasksOf('evt1'), [], 'an empty list clears the entry entirely');

await setSubtasks('evt2', [{ title: 'solo' }]);
await deleteSubtasksFor('evt2');
assert.deepEqual(subtasksOf('evt2'), []);

await initTaskMeta(tmDir); // persistence round-trip does not crash on an empty store
assert.deepEqual(subtasksOf('evt1'), []);

await fs.rm(tmDir, { recursive: true, force: true });

/* ---------- palette search + inbox ---------- */

const T = '2026-05-10';
const sc = (i) => inboxScore(i, T);
assert.ok(sc({ due: '2026-05-09' }) > sc({ due: T }), 'overdue outranks today');
assert.ok(sc({ due: T }) > sc({ due: '2026-05-12' }), 'today outranks within 3 days');
assert.ok(sc({ due: '2026-05-12' }) > sc({ due: null }), 'dated outranks undated');
assert.equal(sc({ due: '2026-06-30' }), 0, 'far future adds nothing');
assert.ok(sc({ priority: 'high' }) > sc({ priority: 'low' }), 'high outranks low');
assert.ok(sc({ review: true }) > sc({}), 'review-requested raises the score');
const ordered = [{ score: 5, due: null, title: 'b' }, { score: 5, due: null, title: 'a' }, { score: 9, due: null, title: 'z' }].sort(inboxOrder);
assert.deepEqual(ordered.map((x) => x.title), ['z', 'a', 'b']);

assert.deepEqual([1, 2, 3, 4, 0].map(prioFromLinear), ['high', 'high', 'med', 'low', null]);
for (const p of ['high', 'med', 'low']) assert.equal(prioFromLinear(prioToLinear(p)), p, 'round trip ' + p);
assert.equal(prioToLinear(null), 0);

const lm = { linearId: 'abc' };
assert.equal(issuePatch({ title: 'x' }, { title: 'x' }, {}), null, 'no linked issue, nothing to sync');
assert.equal(issuePatch({ done: true }, { status: 'completed' }, lm), null, 'done alone is not a field sync');
assert.deepEqual(issuePatch({ title: 'T' }, { title: 'T' }, lm), { title: 'T', dueDate: undefined, priority: undefined });
assert.deepEqual(
  issuePatch({ start: 's', priority: 'high' }, { due: '2026-05-10T00:00:00.000Z' }, lm),
  { title: undefined, dueDate: '2026-05-10', priority: 2 });
assert.equal(issuePatch({ priority: null }, {}, lm).priority, 0, 'clearing priority clears it in Linear');

const good = { id: 'a1b2-c3', url: 'https://linear.app/acme/issue/ENG-12/x', key: 'ENG-12' };
assert.deepEqual(linearLink(good), { linearId: 'a1b2-c3', linearUrl: good.url, linearKey: 'ENG-12' });
for (const bad of [null, 'x', {}, { ...good, url: 'http://linear.app/x' }, { ...good, url: 'https://evil.com/linear.app/x' },
  { ...good, id: 'a b' }, { ...good, key: 'nope' }, { ...good, id: 5 }]) assert.equal(linearLink(bad), null);

assert.ok(matches('Hello World', 'WORLD'));
assert.equal(snippet('nothing here', 'zzz'), null);
const long = 'a'.repeat(100) + ' NEEDLE ' + 'b'.repeat(100);
const snip = snippet(long, 'needle');
assert.ok(snip.includes('NEEDLE') && snip.length <= 40 + 6 + 40, 'snippet is cut to +-40 chars');

assert.equal(driveTerm(`a'b" or name contains 'c`), 'ab or name contains c', 'quotes never reach the query');
assert.equal(driveTerm(`x\'y`), 'xy');

const srcs = (role) => searchSources({ role });
assert.deepEqual(srcs('guest'), ['tasks', 'notes']);
assert.deepEqual(srcs('member'), ['tasks', 'notes', 'drive']);
assert.deepEqual(srcs('admin'), ['tasks', 'notes', 'drive', 'github']);

/* ---------- notes: paths, tags, links ---------- */

for (const ok of ['a.md', 'proj/ideas.md', 'a b/c (2).md', 'a/b/c/d.md']) assert.equal(notePath(ok), ok);
for (const bad of ['../x.md', 'a/../b.md', '/etc/x.md', 'a\\b.md', '.h/x.md', 'a//b.md', 'a/b/c/d/e.md', 'x', './x.md', 'a/.md', '']) {
  assert.throws(() => notePath(bad), /bad note name/, `should reject ${bad}`);
}
assert.equal(noteName('proj/ideas.md'), 'ideas.md', 'noteName is unchanged');

assert.deepEqual(parseNote('# Title\nsome #Alpha and #beta/sub text #alpha\n').tags, ['alpha', 'beta/sub']);
assert.deepEqual(parseNote('x\n```\n#in-block\n```\nand `#inline` and $a_#b$ and $$\n#c\n$$ and http://x.y/p#frag').tags, []);
assert.deepEqual(parseNote('---\ntags: [A, "b c"]\n---\nbody #z').tags, ['a', 'b c', 'z']);
assert.deepEqual(parseNote('---\ntags: one, Two\n---\n').tags, ['one', 'two']);
assert.deepEqual(parseNote('---\ntitle: x\ntags:\n  - L1\n  - #l2\nother: 1\n---\n').tags, ['l1', 'l2']);
// task lists: bullets, numbers, bare markers; code, tables, wiki links and md links do not count
assert.deepEqual(countTasks('- [ ] a\n* [x] b\n+ [X] c\n1. [ ] d\n2) [x] e\n[ ] f\n  [x] g\n\t- [ ] h'), { open: 4, done: 4 });
assert.deepEqual(countTasks('x [ ] mid\n[ ]nospace\n[[x]] y\n[x](http://u) y\n[x]\n- [ ]\n-[ ] a\n- [y] a'), { open: 0, done: 0 });
assert.deepEqual(countTasks('```\n- [ ] code\n[x] code\n```\n~~~md\n- [x] tilde\n~~~\n- [ ] real'), { open: 1, done: 0 }, 'fenced code ignored');
assert.deepEqual(countTasks('| [ ] | a |\n|--|--|\n| - [x] | b |'), { open: 0, done: 0 }, 'tables ignored');
assert.deepEqual(countTasks('- [ ] a\r\n- [x] b\r\n```\r\n- [ ] c\r\n```\r\n'), { open: 1, done: 1 }, 'CRLF');
assert.deepEqual(parseNote('- [ ] a\n- [x] b\n').tasks, { open: 1, done: 1 });
// fences need <= 3 spaces of indent; $$ blocks and block-level HTML are not task lists
assert.deepEqual(countTasks('    ```\n- [ ] a\n    ```\n- [x] b'), { open: 1, done: 1 }, '4-space fence is not a fence');
assert.deepEqual(countTasks('   ```\n- [ ] a\n   ```\n- [x] b'), { open: 0, done: 1 }, '3-space fence is a fence');
assert.deepEqual(countTasks('$$\n- [ ] a\n$$\n- [x] b'), { open: 0, done: 1 }, '$$ block ignored');
assert.deepEqual(countTasks('<div>\n- [ ] a\n</div>\n- [x] b'), { open: 0, done: 1 }, 'html block ignored');
assert.deepEqual(countTasks('<div>\n- [ ] a\n\n- [x] b'), { open: 0, done: 1 }, 'html block ends at a blank line');
assert.deepEqual(countTasks('<b>x</b>\n- [ ] a'), { open: 1, done: 0 }, 'inline html is not a block');
{
  // web/src/lib/mdTask.ts is TypeScript: needs a Node that strips types (22.18+/23.6+).
  const md = await import('./web/src/lib/mdTask.ts').catch(() => null);
  if (md) {
    const { convertToTask, countTasks: mdCount } = md;
    const keep = '| a |\n|---|\n```\n# head\n~~~';
    assert.equal(convertToTask(keep, 0, keep.length).text, keep, 'table / fence / heading untouched');
    assert.equal(convertToTask('a\n# h\nb', 0, 7).text, '- [ ] a\n# h\n- [ ] b');
    assert.equal(convertToTask('- [ ] a\n- [x] b', 0, 15).text, '- a\n- b', 'all tasks -> marker removed');
    const big = Array.from({ length: 10000 }, (_, i) => 'line ' + i).join('\n');
    const t0 = performance.now();
    const r = convertToTask(big, 0, big.length);
    assert.ok(performance.now() - t0 < 200, 'convertToTask is linear on 10k lines');
    assert.equal(mdCount(r.text).open, 10000);
    for (const t of ['- [ ] a\n    ```\n- [x] b', '$$\n[ ] a\n$$\n[x] b', '<div>\n- [x] a\n</div>\n1. [ ] z'])
      assert.deepEqual(mdCount(t), countTasks(t), 'mdTask.countTasks mirrors lib.countTasks');
  }
}
assert.deepEqual(parseNote('see [[Foo]], [[dir/Bar|alias]] and [[Foo#sec]] [[Baz.md]]').links, ['Foo', 'dir/Bar', 'Baz']);

assert.deepEqual(parseNote('| a |\n|---|\n| [[x\\|alias]] [[y\\|b]] [[z#s\\|c]] |').links, ['x', 'y', 'z'], 'escaped alias pipe');

const paths = ['Foo.md', 'proj/Foo.md', 'proj/Bar.md', 'misc/baz.md'];
assert.equal(resolveLink('proj/Foo', paths), 'proj/Foo.md', 'exact path wins');
assert.equal(resolveLink('Foo', paths), 'Foo.md', 'alphabetical first basename');
assert.equal(resolveLink('Foo', paths, 'proj/Bar.md'), 'Foo.md', 'a root note is an exact path, so it wins');
assert.equal(resolveLink('Bar', ['x/Bar.md', 'proj/Bar.md']), 'proj/Bar.md');
assert.equal(resolveLink('Bar', ['x/Bar.md', 'proj/Bar.md'], 'x/Q.md'), 'x/Bar.md', 'same folder breaks the tie');
assert.equal(resolveLink('BAZ', paths), 'misc/baz.md', 'case-insensitive basename');
assert.equal(resolveLink('nope', paths), null);
const ents = [
  { rel: 'Foo.md', links: [] }, { rel: 'proj/Bar.md', links: ['Foo', 'misc/baz'] },
  { rel: 'misc/baz.md', links: ['proj/Foo'] }, { rel: 'proj/Foo.md', links: ['Foo'] },
];
assert.deepEqual(backlinksOf(ents, 'Foo.md').sort(), ['proj/Bar.md', 'proj/Foo.md'], 'bare [[Foo]] resolves to the root note');
assert.deepEqual(backlinksOf(ents, 'proj/Foo.md'), ['misc/baz.md']);
assert.deepEqual(backlinksOf(ents, 'misc/baz.md'), ['proj/Bar.md']);

const rw = (body, from, to) => rewriteLinks(body, from, to, ['a.md', 'x/old.md', 'y/other.md'], 'y/other.md');
assert.deepEqual(rw('[[old|al]] [[x/old#sec]] [[x/old.md|z]] [[other]]', 'x/old.md', 'x/new.md'),
  { body: '[[new|al]] [[x/new#sec]] [[x/new.md|z]] [[other]]', n: 3 });
assert.deepEqual(rw('[[old]] [[x/old]]', 'x/old.md', 'z/old.md'),
  { body: '[[old]] [[z/old]]', n: 1 }, 'folder move leaves [[basename]] alone');
assert.deepEqual(rw('| [[old\\|al]] | [[x/old#s\\|z]] |', 'x/old.md', 'x/new.md'),
  { body: '| [[new\\|al]] | [[x/new#s\\|z]] |', n: 2 }, 'escaped alias kept on rewrite');
assert.deepEqual(backlinksOf([{ rel: 'a.md', links: parseNote('[[old\\|al]]').links }, { rel: 'x/old.md', links: [] }], 'x/old.md'), ['a.md'], 'backlink through \\|');
assert.equal(rw('nothing [[a]]', 'x/old.md', 'x/new.md').n, 0);

const nentries = [
  { rel: 'a.md', mtimeMs: 1, tags: ['x'], body: 'hello world' },
  { rel: 'proj/hello.md', mtimeMs: 2, tags: ['y', 'x/sub'], body: 'nothing' },
  { rel: 'proj/z.md', mtimeMs: 3, tags: [], body: 'say Hello there' },
];
assert.deepEqual(filterNotes(nentries).map((n) => n.name), ['proj/z.md', 'proj/hello.md', 'a.md']);
assert.deepEqual(filterNotes(nentries, { q: 'hello' }).map((n) => n.name), ['proj/hello.md', 'proj/z.md', 'a.md'], 'name hits first');
assert.equal(filterNotes(nentries, { q: 'hello' })[1].snippet, 'say Hello there');
assert.deepEqual(filterNotes(nentries, { q: 'y' }).map((n) => n.name), ['proj/z.md', 'proj/hello.md'], 'body hit, then tag-only hit');
assert.deepEqual(filterNotes(nentries, { q: '#x' }).map((n) => n.name), ['proj/hello.md', 'a.md'], '#tag filter, incl. nested');
assert.deepEqual(filterNotes(nentries, { tag: 'y' }).map((n) => n.name), ['proj/hello.md']);
assert.deepEqual(filterNotes(nentries, { folder: 'proj' }).map((n) => n.folder), ['proj', 'proj']);
assert.equal(filterNotes(Array.from({ length: 300 }, (_, i) => ({ rel: `n${i}.md`, mtimeMs: i, tags: [], body: '' }))).length, 200);
assert.equal(filterNotes(nentries, {}, Infinity).length, 3);

/* ---------- reminders + digest ---------- */

const inst = new Date('2026-03-10T23:30:00Z');
assert.deepEqual(localNow('Asia/Tokyo', inst), { date: '2026-03-11', min: 8 * 60 + 30 });
assert.deepEqual(localNow('America/Mexico_City', inst), { date: '2026-03-10', min: 17 * 60 + 30 });
assert.deepEqual(localNow('UTC', new Date('2026-03-10T00:05:00Z')), { date: '2026-03-10', min: 5 }, 'midnight is hour 0, not 24');

assert.deepEqual(cleanNotify({ enabled: true, digestAt: '07:45', leadMin: 15 }), { enabled: true, digestAt: '07:45', leadMin: 15 });
assert.deepEqual(cleanNotify({ enabled: 'yes', digestAt: '24:00', leadMin: 999 }), { enabled: false, digestAt: null, leadMin: 120 });
assert.equal(cleanNotify({ digestAt: '7:5' }).digestAt, null);
assert.equal(cleanNotify({ leadMin: 1 }).leadMin, 5);
assert.equal(cleanNotify({}).leadMin, 10);
assert.equal(cleanNotify(null).enabled, false);

const R0 = new Date('2026-05-10T12:00:00Z');
const ev = (id, start, extra = {}) => ({ id, title: id, start, allDay: false, task: false, done: false, ...extra });
const rem = (o) => dueReminders({ now: R0, leadMin: 10, ...o });
assert.deepEqual(rem({ events: [ev('in', '2026-05-10T12:07:00Z')] }).map((r) => r.key), ['ev:in:2026-05-10T12:07:00Z']);
assert.deepEqual(rem({ events: [ev('edge', '2026-05-10T12:10:00Z')] }).length, 1, 'lead window is inclusive');
assert.deepEqual(rem({ events: [ev('far', '2026-05-10T12:11:00Z'), ev('past', '2026-05-10T11:59:00Z'), ev('now', '2026-05-10T12:00:00Z')] }), []);
assert.deepEqual(rem({ events: [ev('ad', '2026-05-10', { allDay: true })] }), [], 'all-day events have no point reminder');
assert.deepEqual(rem({ events: [ev('in', '2026-05-10T12:07:00Z')], sent: { 'ev:in:2026-05-10T12:07:00Z': 'x' } }), [], 'already sent');
assert.equal(rem({ events: [ev('in', '2026-05-10T12:09:00Z')], sent: { 'ev:in:2026-05-10T12:07:00Z': 'x' } }).length, 1, 'moved event is announced again');
const tk = { id: 't1', title: 'T', start: '2026-05-10T14:05:00', allDay: false, done: false };
assert.equal(rem({ tasks: [tk], tz: 'Europe/Madrid' })[0].key, 'tk:t1:2026-05-10T14:05:00', 'naive task time is read in the user zone');
assert.deepEqual(rem({ tasks: [{ ...tk, start: '2026-05-10', allDay: true }] }), [], 'untimed task: digest only');
assert.deepEqual(rem({ tasks: [{ ...tk, done: true }], tz: 'Europe/Madrid' }), []);

// 08:00 in Tokyo is 23:00Z the day before; the window is [08:00, 14:00) local.
const st = { enabled: true, digestAt: '08:00', leadMin: 10 };
const dd = (iso, o = {}) => digestDue({ settings: st, tz: 'Asia/Tokyo', now: new Date(iso), lastDigestDate: null, ...o });
assert.equal(dd('2026-05-09T22:59:00Z'), false, 'before');
assert.equal(dd('2026-05-09T23:00:00Z'), true, 'at');
assert.equal(dd('2026-05-10T04:59:00Z'), true, 'inside the window');
assert.equal(dd('2026-05-10T05:00:00Z'), false, 'after the 6 h window');
assert.equal(dd('2026-05-09T23:30:00Z', { lastDigestDate: '2026-05-10' }), false, 'already sent today');
assert.equal(dd('2026-05-10T23:30:00Z', { lastDigestDate: '2026-05-10' }), true, 'next local day');
assert.equal(dd('2026-05-09T23:30:00Z', { tz: 'America/Mexico_City' }), false, 'same instant, 17:30 in Mexico City');
assert.equal(dd('2026-05-09T23:30:00Z', { settings: { ...st, enabled: false } }), false);
assert.equal(dd('2026-05-09T23:30:00Z', { settings: { ...st, digestAt: null } }), false);

const dg = digestItem({
  tz: 'Asia/Tokyo', now: new Date('2026-05-09T23:30:00Z'),
  events: [
    ev('b', '2026-05-10T10:00:00+09:00', { title: 'Lunch' }), ev('a', '2026-05-10T09:00:00+09:00', { title: 'Standup' }),
    ev('d', '2026-05-11', { allDay: true, title: 'Tomorrow' }), ev('c', '2026-05-10', { allDay: true, title: 'Holiday' }),
  ],
  inboxItems: [
    { title: 'Late', due: '2026-05-09' }, { title: 'Today', due: '2026-05-10' }, { title: 'Someday', due: null },
  ],
});
assert.equal(dg.key, 'digest:2026-05-10');
assert.equal(dg.kind, 'digest');
assert.ok(dg.body.indexOf('09:00  Standup') < dg.body.indexOf('10:00  Lunch'), 'agenda in time order');
assert.ok(dg.body.includes('All day  Holiday') && !dg.body.includes('Tomorrow'));
for (const s of ['Overdue\n- Late', 'Due today\n- Today', 'Inbox\n- Someday']) assert.ok(dg.body.includes(s), s);
assert.equal(digestItem({ tz: 'UTC', now: R0 }).body, 'Nothing scheduled today.');

/* ---------- notify.js ---------- */

{
  const nd = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-notify-'));
  await initNotify(nd);
  assert.deepEqual(getSettings('u1'), { enabled: false, digestAt: '08:00', leadMin: 10 });
  await setSettings('u1', { enabled: true, digestAt: null, leadMin: 20 });

  const t0 = new Date('2026-05-10T12:00:00Z');
  assert.equal(await push('u1', { key: 'k1', kind: 'reminder', title: 'A', body: 'b' }, t0), true);
  assert.equal(await push('u1', { key: 'k1', kind: 'reminder', title: 'A again', body: 'b' }, t0), false, 'same key is delivered once');
  await push('u1', { key: 'k2', kind: 'digest', title: 'B', body: 'b' }, t0);
  assert.deepEqual(feedOf('u1').map((n) => n.title), ['B', 'A'], 'newest first');
  assert.equal(unreadOf('u1'), 2);
  const [first] = feedOf('u1');
  assert.equal(await markRead('u1', [first.id]), 1);
  assert.equal(await markRead('u1', []), 0, 'no ids marks everything');
  assert.equal(await markRead('nobody', []), 0);

  // Feed is capped at 50; sent keys older than 3 days are forgotten on the next push.
  for (let i = 0; i < 60; i++) await push('u1', { key: `f${i}`, kind: 'reminder', title: String(i), body: '' }, t0);
  assert.equal(feedOf('u1').length, 50);
  sentAdd('u1', 'old', new Date(t0.getTime() - 4 * 864e5));
  sentAdd('u1', 'recent', new Date(t0.getTime() - 2 * 864e5));
  pruneSent('u1', t0);
  assert.equal(sentHas('u1', 'old'), false);
  assert.equal(sentHas('u1', 'recent'), true);
  await setDigestDate('u1', '2026-05-10');

  await initNotify(nd); // restart
  assert.equal(getSettings('u1').leadMin, 20);
  assert.equal(digestDateOf('u1'), '2026-05-10');
  assert.equal(feedOf('u1').length, 50);
  assert.equal(await push('u1', { key: 'f59', kind: 'reminder', title: 'dup', body: '' }, t0), false, 'dedupe survives a restart');
  await fs.rm(nd, { recursive: true, force: true });
}

// Concurrent writers share one tmp name: they must be serialised, none may reject.
{
  const nd = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-notify-'));
  await initNotify(nd);
  const ops = [];
  for (let i = 0; i < 40; i++) {
    ops.push(push('c1', { key: `c${i}`, kind: 'reminder', title: String(i), body: '' }));
    if (i % 3 === 0) ops.push(markRead('c1', []));
  }
  const res = await Promise.allSettled(ops);
  assert.equal(res.filter((r) => r.status === 'rejected').length, 0, 'no rejected writes');
  await markRead('c1', []);
  await initNotify(nd);
  assert.equal(feedOf('c1').length, 40);
  assert.equal(unreadOf('c1'), 0);
  await fs.rm(nd, { recursive: true, force: true });
}

// A corrupt notify.json must not stop startup; it is kept as .bak.
{
  const nd = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-notify-'));
  await fs.writeFile(path.join(nd, 'notify.json'), '{ not json');
  await initNotify(nd);
  assert.deepEqual(feedOf('x'), []);
  assert.equal(await fs.readFile(path.join(nd, 'notify.json.bak'), 'utf8'), '{ not json');
  assert.equal(await push('x', { key: 'k', kind: 'reminder', title: 't', body: '' }), true);
  await fs.rm(nd, { recursive: true, force: true });
}

/* ---------- server: unauthenticated API access ---------- */

{
  const { spawn } = await import('node:child_process');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-test-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: import.meta.dirname,
    env: { ...process.env, DATA_DIR: dir, PORT: '0', HOST: '127.0.0.1', MAC_LOGIN: 'false', ACCESS_PASSWORD: 'test-password-123' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    const port = await new Promise((resolve, reject) => {
      let out = '';
      const t = setTimeout(() => reject(new Error('server did not start')), 30000);
      child.on('exit', (c) => reject(new Error(`server exited early (${c})`)));
      child.stdout.on('data', (d) => {
        out += d;
        const m = /listening on \S+:(\d+)/.exec(out);
        if (m) { clearTimeout(t); resolve(Number(m[1])); }
      });
    });
    for (const p of ['/api/search?q=ab', '/api/inbox', '/api/tasks', '/api/notifications', '/api/notes', '/api/quick/parse?text=x']) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`);
      assert.equal(r.status, 401, `${p} requires a session`);
    }
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/tasks/quick`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x' }),
    })).status, 401, 'quick create requires a session');

    // Signed in as the bootstrap admin: nested notes round-trip and nothing escapes the
    // person's own notes dir.
    const base = `http://127.0.0.1:${port}`;
    const login = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Owner', password: 'test-password-123' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const uid = (await login.json()).user.id;
    const call = (m, p, body) => fetch(base + p, {
      method: m, headers: { cookie, 'content-type': 'application/json' }, body: body && JSON.stringify(body),
    });

    // Quick capture: parsing is read-only, and an empty title is refused before anything is created.
    const parse = (text) => call('GET', '/api/quick/parse?text=' + encodeURIComponent(text));
    const qp = await (await parse('mañana 3pm revisar PR p1 30m')).json();
    assert.deepEqual([qp.title, qp.priority, qp.duration, qp.hasTime, qp.project], ['revisar PR', 'high', 30, true, null]);
    assert.match((await (await parse('x !dash')).json()).warnings[0], /proyectos de Linear/);
    assert.equal((await parse('x'.repeat(301))).status, 400);
    assert.equal((await call('POST', '/api/tasks/quick', { text: 'mañana p1' })).status, 400);
    assert.equal((await call('POST', '/api/tasks/quick', { text: 'x'.repeat(301) })).status, 400);

    assert.equal((await call('PUT', '/api/notes/a/b.md', { body: 'hi #t1' })).status, 200);
    assert.equal((await call('PUT', '/api/notes/c.md', { body: 'see [[a/b]] and [[b]]' })).status, 200);
    const got = await (await call('GET', '/api/notes/a/b.md')).json();
    assert.deepEqual([got.name, got.tags, got.backlinks], ['a/b.md', ['t1'], ['c.md']]);
    const list = await (await call('GET', '/api/notes')).json();
    assert.deepEqual(list.map((n) => n.name).sort(), ['a/b.md', 'c.md']);
    assert.ok(list.every((n) => !('tasks' in n)), 'no tasks field on notes without tasks');
    assert.equal((await call('PUT', '/api/notes/todo.md', { body: '- [ ] a\n[x] b\n```\n- [ ] code\n```\n' })).status, 200);
    const withTasks = (await (await call('GET', '/api/notes')).json()).find((n) => n.name === 'todo.md');
    assert.deepEqual(withTasks.tasks, { open: 1, done: 1 });
    assert.equal((await call('DELETE', '/api/notes/todo.md')).status, 200);
    assert.equal((await (await call('GET', '/api/notes?tag=t1')).json())[0].folder, 'a');

    const mv = await (await call('POST', '/api/notes/rename', { from: 'a/b.md', to: 'z/b2.md' })).json();
    assert.deepEqual(mv, { name: 'z/b2.md', rewritten: 1 });
    assert.equal((await call('GET', '/api/notes/c.md')).status, 200);
    assert.equal((await (await call('GET', '/api/notes/c.md')).json()).body, 'see [[z/b2]] and [[b2]]');
    assert.equal((await call('POST', '/api/notes/rename', { from: 'c.md', to: 'z/b2.md' })).status, 409);
    await assert.rejects(fs.stat(path.join(dir, 'notes', uid, 'a')), 'emptied folder is removed');

    assert.equal((await call('PUT', '/api/notes/dd.md/n.md', { body: 'x' })).status, 200);
    assert.equal((await call('PUT', '/api/notes/dd.md', { body: 'x' })).status, 409, 'name is a folder');
    assert.equal((await call('POST', '/api/notes/rename', { from: 'c.md', to: 'dd.md' })).status, 409);
    assert.equal((await call('DELETE', '/api/notes/dd.md/n.md')).status, 200);

    for (const bad of ['..%2Fx.md', 'a%2F..%2Fb.md', '.h%2Fx.md']) {
      assert.equal((await call('PUT', `/api/notes/${bad}`, { body: 'x' })).status, 400, bad);
    }
    assert.equal((await call('POST', '/api/notes/rename', { from: 'c.md', to: '../x.md' })).status, 400);
    assert.deepEqual((await fs.readdir(path.join(dir, 'notes'))).sort(), [uid]);
    assert.equal((await call('DELETE', '/api/notes/z/b2.md')).status, 200);
    assert.equal((await (await call('GET', '/api/notes')).json()).length, 1);

    // Pasted images: private per person, typed by content, bounded, and nothing leaves assets/<uid>.
    {
      const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
      const up = (ck, body, type = 'image/png', extra = {}) => fetch(`${base}/api/notes/assets`, {
        method: 'POST', headers: { ...(ck ? { cookie: ck } : {}), 'content-type': type, ...extra }, body,
      });
      const login2 = async (name, password) => {
        const r = await fetch(`${base}/api/login`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, password }),
        });
        assert.equal(r.status, 200);
        return r.headers.get('set-cookie').split(';')[0];
      };
      assert.equal((await call('POST', '/api/access/users', { name: 'Writer', role: 'member', password: 'writer-pass-123' })).status, 200);
      assert.equal((await call('POST', '/api/access/users', { name: 'Reader', role: 'guest', password: 'reader-pass-123' })).status, 200);
      const writer = await login2('Writer', 'writer-pass-123');
      const reader = await login2('Reader', 'reader-pass-123');

      assert.equal((await up(null, PNG)).status, 401);
      assert.equal((await fetch(`${base}/notes/assets/${'a'.repeat(32)}.png`)).status, 401);
      assert.equal((await up(reader, PNG)).status, 403, 'no notes:write');

      const ok = await up(cookie, PNG);
      assert.equal(ok.status, 201);
      const a = await ok.json();
      assert.match(a.name, /^[a-f0-9]{32}\.png$/);
      assert.deepEqual([a.id + '.png', a.url, a.bytes, a.type], [a.name, `/notes/assets/${a.name}`, PNG.length, 'image/png']);
      assert.equal(JSON.stringify(a).includes(dir), false, 'no disk paths in the response');

      const got = await fetch(base + a.url, { headers: { cookie } });
      assert.equal(got.status, 200);
      assert.ok(Buffer.from(await got.arrayBuffer()).equals(PNG));
      const h = (k) => got.headers.get(k);
      assert.deepEqual([h('content-type'), h('x-content-type-options'), h('content-disposition'), h('cross-origin-resource-policy'), h('referrer-policy')],
        ['image/png', 'nosniff', 'inline', 'same-origin', 'no-referrer']);
      assert.equal(h('content-security-policy'), "default-src 'none'; img-src 'self'; style-src 'none'; sandbox");
      assert.equal(h('cache-control'), 'private, max-age=31536000, immutable');
      assert.equal((await fetch(base + a.url, { method: 'HEAD', headers: { cookie } })).status, 200);
      assert.equal((await fetch(base + a.url, { headers: { cookie, 'if-none-match': h('etag') }, cache: 'force-cache' })).status, 304); // fetch adds no-cache to conditional requests unless told not to

      // Another signed-in person gets a plain 404, exactly as for an id that does not exist.
      assert.equal((await fetch(base + a.url, { headers: { cookie: writer } })).status, 404);
      assert.equal((await fetch(`${base}/notes/assets/${'0'.repeat(32)}.png`, { headers: { cookie } })).status, 404);
      for (const bad of ['..%2F..%2Fauth.json', '%2e%2e%2fauth.json', 'a%2Fb.png', a.name.toUpperCase(), a.name + '.html', a.name + '%00', a.id.slice(1) + '.png', a.id + '.svg']) {
        assert.equal((await fetch(`${base}/notes/assets/${bad}`, { headers: { cookie } })).status, 404, bad);
      }

      // Content decides, not the declared type or name.
      for (const [what, body, type] of [
        ['script as image/png', '<script>alert(1)</script>', 'image/png'],
        ['svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>', 'image/svg+xml'],
        ['svg as png', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/png'],
        ['real png, wrong type', PNG, 'text/html'],
        ['real png, json type', PNG, 'application/json'],
      ]) assert.equal((await up(cookie, body, type)).status, 415, what);
      assert.equal((await up(cookie, Buffer.concat([Buffer.from('GIF89a'), Buffer.from('<script>1</script>')]), 'image/gif')).status, 400, 'gif header over html');
      assert.equal((await up(cookie, PNG.subarray(0, 20))).status, 400, 'truncated');
      const wide = Buffer.from(PNG); wide.writeUInt32BE(9000, 16);
      assert.equal((await up(cookie, wide)).status, 400, 'too wide');
      assert.ok([400, 415].includes((await up(cookie, Buffer.alloc(0))).status), 'empty');
      assert.equal((await up(cookie, PNG, 'image/*')).status, 415, 'literal image/* is a bad type, not an empty body');
      assert.equal((await up(cookie, Buffer.alloc(5 * 1024 * 1024 + 1, 1))).status, 413);
      assert.equal((await up(cookie, PNG, 'image/png', { 'sec-fetch-site': 'cross-site' })).status, 403);
      assert.equal((await up(cookie, PNG, 'image/png', { origin: 'https://evil.example' })).status, 403);
      assert.equal((await up(cookie, PNG, 'image/png', { origin: base })).status, 201);

      // JPEG metadata (EXIF/GPS) never reaches the disk.
      const jpg = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 18]), Buffer.from('Exif\0\0GPS-SECRET', 'latin1'),
        Buffer.from([0xff, 0xc0, 0, 11, 8, 0, 2, 0, 2, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 9, 0xff, 0xd9]),
      ]);
      const j = await (await up(cookie, jpg, 'image/jpeg')).json();
      assert.match(j.name, /\.jpg$/);
      const stored = await fs.readFile(path.join(dir, 'assets', uid, j.name));
      assert.ok(jpg.includes('GPS-SECRET') && !stored.includes('GPS-SECRET'));
      const back = await fetch(base + j.url, { headers: { cookie } });
      assert.ok(Buffer.from(await back.arrayBuffer()).equals(stored));
      assert.equal(back.headers.get('content-type'), 'image/jpeg');

      // Everything landed in assets/<uid>, only valid names, no temp leftovers, no note index noise.
      assert.deepEqual(await fs.readdir(path.join(dir, 'assets')), [uid]);
      const mine = await fs.readdir(path.join(dir, 'assets', uid));
      assert.equal(mine.length, 3);
      assert.ok(mine.every((n) => /^[a-f0-9]{32}\.(png|jpg)$/.test(n)));
      assert.equal((await (await call('GET', '/api/notes')).json()).length, 1, 'images are not notes');

      // Quota: 200 files per person.
      for (let i = mine.length; i < 200; i++) await fs.writeFile(path.join(dir, 'assets', uid, `${String(i).padStart(32, '0')}.png`), PNG);
      const full = await up(cookie, PNG);
      assert.equal(full.status, 507);
      assert.match((await full.json()).error, /Clean unused images/);
      assert.equal((await fetch(base + a.url, { headers: { cookie } })).status, 200, 'existing files still served');
      assert.equal((await fetch(base + a.url + '/', { headers: { cookie } })).status, 404, 'trailing slash');

      // Freeing quota: list, delete, prune. One note links a.png; all but one filler are an hour old.
      const adir = path.join(dir, 'assets', uid);
      const hourAgo = new Date(Date.now() - 3600_000);
      const fresh = `${String(199).padStart(32, '0')}.png`;
      for (const n of await fs.readdir(adir)) if (n !== fresh) await fs.utimes(path.join(adir, n), hourAgo, hourAgo);
      assert.equal((await call('PUT', '/api/notes/img.md', { body: `![x](${base}${a.url})` })).status, 200);
      const lst = await (await fetch(`${base}/api/notes/assets`, { headers: { cookie } })).json();
      assert.deepEqual([lst.count, lst.limits, lst.totalBytes > 0], [200, { files: 200, bytes: 200 * 1024 * 1024 }, true]);
      assert.deepEqual(lst.files.find((f) => f.name === a.name).usedBy, ['img.md']);
      assert.ok(lst.files.filter((f) => f.name !== a.name).every((f) => f.usedBy.length === 0 && f.bytes > 0 && !Number.isNaN(Date.parse(f.modified))));
      assert.equal(JSON.stringify(lst).includes(dir), false);
      const mut = (ck, method, p) => fetch(`${base}${p}`, { method, headers: { cookie: ck } });
      assert.equal((await mut(reader, 'GET', '/api/notes/assets')).status, 403);
      assert.equal((await mut(reader, 'DELETE', `/api/notes/assets/${a.name}`)).status, 403, 'no notes:write');
      assert.equal((await mut(reader, 'POST', '/api/notes/assets/prune')).status, 403);
      assert.equal((await mut(writer, 'DELETE', `/api/notes/assets/${a.name}`)).status, 404, 'not theirs');
      assert.equal((await mut(cookie, 'DELETE', '/api/notes/assets/..%2F..%2Fauth.json')).status, 404);
      assert.equal((await mut(cookie, 'DELETE', `/api/notes/assets/${'1'.repeat(32)}.png`)).status, 404);
      const pr = await (await mut(cookie, 'POST', '/api/notes/assets/prune')).json();
      assert.equal(pr.removed, 198, 'all but the referenced and the fresh one');
      assert.ok(pr.freedBytes > 0);
      assert.deepEqual((await fs.readdir(adir)).sort(), [a.name, fresh].sort());
      assert.equal((await fetch(base + a.url, { headers: { cookie } })).status, 200);
      assert.equal((await up(cookie, PNG)).status, 201, 'quota is usable again');
      assert.deepEqual(await (await mut(cookie, 'POST', '/api/notes/assets/prune')).json(), { removed: 0, freedBytes: 0 }, 'new and linked images stay');

      // Hostile JPEG: ~1.2M empty APP1 segments used to stall the event loop for 1.5 s and balloon memory.
      const hostile = Buffer.alloc(2 + 4 * 1_200_000);
      hostile.set([0xff, 0xd8]);
      for (let i = 0; i < 1_200_000; i++) hostile.set([0xff, 0xe1, 0, 2], 2 + i * 4);
      const t0 = Date.now();
      assert.equal((await up(cookie, hostile, 'image/jpeg')).status, 400, 'hostile jpeg refused');
      assert.ok(Date.now() - t0 < 1000, 'and cheaply');
      // A normal photo with three APP1 segments still goes through, all stripped.
      const app1 = (t) => Buffer.concat([Buffer.from([0xff, 0xe1, 0, t.length + 2]), Buffer.from(t, 'latin1')]);
      const three = Buffer.concat([Buffer.from([0xff, 0xd8]), app1('EXIF-ONE'), app1('XMP-TWO'), app1('ICC-THREE'), jpg.subarray(jpg.indexOf(Buffer.from([0xff, 0xc0])))]);
      const r3 = await up(cookie, three, 'image/jpeg');
      assert.equal(r3.status, 201);
      const kept = await fs.readFile(path.join(adir, (await r3.json()).name));
      assert.ok(three.includes('EXIF-ONE') && !kept.includes('EXIF-ONE') && !kept.includes('XMP-TWO') && !kept.includes('ICC-THREE'));

      // DELETE removes one image and says which notes still link to it.
      const del = await (await mut(cookie, 'DELETE', `/api/notes/assets/${a.name}`)).json();
      assert.deepEqual(del, { ok: true, wasUsedBy: ['img.md'] });
      assert.equal((await fetch(base + a.url, { headers: { cookie } })).status, 404);
      assert.equal((await mut(cookie, 'DELETE', `/api/notes/assets/${a.name}`)).status, 404);

      // Rate limit: 30 attempts a minute per person, failed ones included.
      for (let i = 0; i < 30; i++) assert.equal((await up(writer, 'x', 'text/plain')).status, 415, `attempt ${i}`);
      assert.equal((await up(writer, PNG)).status, 429);
    }

    const nf = await (await call('GET', '/api/notifications')).json();
    assert.deepEqual([nf.unread, nf.items, nf.settings.enabled], [0, [], false]);
    const put = await (await call('PUT', '/api/notifications/settings', { enabled: true, digestAt: 'bad', leadMin: 500 })).json();
    assert.deepEqual(put, { enabled: true, digestAt: null, leadMin: 120 });
    assert.deepEqual(await (await call('POST', '/api/notifications/read', {})).json(), { unread: 0 });
  } finally {
    child.removeAllListeners('exit');
    child.kill();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

console.log('ok');
